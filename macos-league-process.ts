import { execFile } from "child_process";
import { realpathSync } from "fs";
import { basename, dirname, join } from "path";
import { promisify } from "util";
import { dlopen } from "node:ffi";
import { Agent, fetch } from "undici";

export const LIB_SYSTEM_PATH = "/usr/lib/libSystem.B.dylib";
export const LIB_OBJC_PATH = "/usr/lib/libobjc.A.dylib";
export const APP_KIT_PATH =
  "/System/Library/Frameworks/AppKit.framework/Versions/Current/AppKit";
export const PLUTIL_PATH = "/usr/bin/plutil";
export const LEAGUE_GAME_BUNDLE_ID =
  "com.riotgames.LeagueofLegends.GameClient";
export const LEAGUE_GAME_API_URL =
  "https://127.0.0.1:2999/liveclientdata/gamestats";
export const LEAGUE_GAME_API_TIMEOUT_MS = 1_000;

const PROC_ALL_PIDS = 1;
const PROC_PIDTBSDINFO = 3;
const PROC_PIDPATHINFO_MAXSIZE = 4_096;
const PROC_BSDINFO_SIZE = 136;
const PROC_BSDINFO_UID_OFFSET = 20;
const PROC_BSDINFO_START_SECONDS_OFFSET = 120;
const PROC_BSDINFO_START_MICROSECONDS_OFFSET = 128;

const LIBPROC_SYMBOLS = {
  proc_listpids: {
    arguments: ["u32", "u32", "buffer", "i32"],
    return: "i32",
  },
  proc_pidpath: {
    arguments: ["i32", "buffer", "u32"],
    return: "i32",
  },
  proc_pidinfo: {
    arguments: ["i32", "i32", "u64", "buffer", "i32"],
    return: "i32",
  },
} as const;

const OBJC_SYMBOLS = {
  objc_getClass: {
    arguments: ["string"],
    return: "pointer",
  },
  sel_registerName: {
    arguments: ["string"],
    return: "pointer",
  },
  objc_msgSend: {
    arguments: ["pointer", "pointer"],
    return: "pointer",
  },
} as const;

export type ProcessStartTime = {
  seconds: bigint;
  microseconds: bigint;
};

export type MacOSProcessSnapshot = {
  pid: number;
  uid: number;
  executablePath: string;
  startTime: ProcessStartTime;
};

export type LeagueGameProcessIdentity = MacOSProcessSnapshot & {
  bundlePath: string;
};

export type MacOSProcessSource = {
  list: () => MacOSProcessSnapshot[];
  get: (pid: number) => MacOSProcessSnapshot | undefined;
};

export type LeagueProcessDependencies = {
  processSource: MacOSProcessSource;
  currentUid: () => number;
  canonicalizePath: (path: string) => string;
  readBundleValue: (plistPath: string, key: string) => Promise<string>;
  frontmostPid: () => number | undefined;
  gameApiOnline: () => Promise<boolean>;
  signal: (pid: number, signal: NodeJS.Signals) => void;
};

const execFileAsync = promisify(execFile);

function inspectPid(
  pid: number,
  functions: {
    proc_pidpath: (
      pid: number,
      buffer: Buffer,
      bufferSize: number
    ) => number;
    proc_pidinfo: (
      pid: number,
      flavor: number,
      arg: bigint,
      buffer: Buffer,
      bufferSize: number
    ) => number;
  }
): MacOSProcessSnapshot | undefined {
  if (!Number.isInteger(pid) || pid <= 1) {
    return undefined;
  }

  const info = Buffer.alloc(PROC_BSDINFO_SIZE);
  const infoBytes = functions.proc_pidinfo(
    pid,
    PROC_PIDTBSDINFO,
    0n,
    info,
    info.length
  );
  if (infoBytes < PROC_BSDINFO_SIZE) {
    return undefined;
  }

  const pathBuffer = Buffer.alloc(PROC_PIDPATHINFO_MAXSIZE);
  const pathBytes = functions.proc_pidpath(
    pid,
    pathBuffer,
    pathBuffer.length
  );
  if (pathBytes <= 0) {
    return undefined;
  }

  const executablePath = pathBuffer
    .subarray(0, pathBytes)
    .toString("utf8")
    .replace(/\0.*$/s, "");
  if (!executablePath) {
    return undefined;
  }

  return {
    pid,
    uid: info.readUInt32LE(PROC_BSDINFO_UID_OFFSET),
    executablePath,
    startTime: {
      seconds: info.readBigUInt64LE(
        PROC_BSDINFO_START_SECONDS_OFFSET
      ),
      microseconds: info.readBigUInt64LE(
        PROC_BSDINFO_START_MICROSECONDS_OFFSET
      ),
    },
  };
}

export function createNativeProcessSource(): MacOSProcessSource {
  return {
    list: () => {
      const { lib, functions } = dlopen(
        LIB_SYSTEM_PATH,
        LIBPROC_SYMBOLS
      );
      try {
        const requiredBytes = functions.proc_listpids(
          PROC_ALL_PIDS,
          0,
          null,
          0
        );
        if (requiredBytes <= 0) {
          return [];
        }

        const pidBuffer = Buffer.alloc(requiredBytes + 4_096);
        const returnedBytes = functions.proc_listpids(
          PROC_ALL_PIDS,
          0,
          pidBuffer,
          pidBuffer.length
        );
        if (returnedBytes <= 0) {
          return [];
        }

        const snapshots: MacOSProcessSnapshot[] = [];
        for (
          let offset = 0;
          offset + 4 <= returnedBytes;
          offset += 4
        ) {
          const snapshot = inspectPid(
            pidBuffer.readInt32LE(offset),
            functions
          );
          if (snapshot) {
            snapshots.push(snapshot);
          }
        }
        return snapshots;
      } finally {
        lib.close();
      }
    },
    get: (pid) => {
      const { lib, functions } = dlopen(
        LIB_SYSTEM_PATH,
        LIBPROC_SYMBOLS
      );
      try {
        return inspectPid(pid, functions);
      } finally {
        lib.close();
      }
    },
  };
}

export function getFrontmostApplicationPid(): number | undefined {
  // Loading AppKit makes NSWorkspace available to the Objective-C runtime.
  const appKit = dlopen(APP_KIT_PATH, {});
  const objc = dlopen(LIB_OBJC_PATH, OBJC_SYMBOLS);
  try {
    const workspaceClass = objc.functions.objc_getClass("NSWorkspace");
    const sharedWorkspaceSelector =
      objc.functions.sel_registerName("sharedWorkspace");
    const frontmostSelector =
      objc.functions.sel_registerName("frontmostApplication");
    const pidSelector =
      objc.functions.sel_registerName("processIdentifier");
    if (
      workspaceClass === null ||
      sharedWorkspaceSelector === null ||
      frontmostSelector === null ||
      pidSelector === null
    ) {
      return undefined;
    }

    const workspace = objc.functions.objc_msgSend(
      workspaceClass,
      sharedWorkspaceSelector
    );
    if (workspace === null) {
      return undefined;
    }
    const application = objc.functions.objc_msgSend(
      workspace,
      frontmostSelector
    );
    if (application === null) {
      return undefined;
    }
    const rawPid = objc.functions.objc_msgSend(
      application,
      pidSelector
    );
    if (rawPid === null) {
      return undefined;
    }

    const pid = Number(rawPid & 0xffff_ffffn);
    return Number.isInteger(pid) && pid > 1 ? pid : undefined;
  } finally {
    objc.lib.close();
    appKit.lib.close();
  }
}

export async function readPlistValue(
  plistPath: string,
  key: string
): Promise<string> {
  const { stdout } = await execFileAsync(
    PLUTIL_PATH,
    ["-extract", key, "raw", "-o", "-", plistPath],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1_024,
    }
  );
  return stdout.trim();
}

export async function isLeagueGameApiOnline(): Promise<boolean> {
  const dispatcher = new Agent({
    connect: { rejectUnauthorized: false },
  });
  try {
    const response = await fetch(LEAGUE_GAME_API_URL, {
      dispatcher,
      signal: AbortSignal.timeout(LEAGUE_GAME_API_TIMEOUT_MS),
    });
    if (!response.ok) {
      return false;
    }
    const payload: unknown = await response.json();
    return (
      typeof payload === "object" &&
      payload !== null &&
      typeof (payload as { gameTime?: unknown }).gameTime === "number" &&
      typeof (payload as { gameMode?: unknown }).gameMode === "string"
    );
  } catch {
    return false;
  } finally {
    await dispatcher.close();
  }
}

export function createDefaultLeagueProcessDependencies(): LeagueProcessDependencies {
  return {
    processSource: createNativeProcessSource(),
    currentUid: () => process.getuid?.() ?? -1,
    canonicalizePath: (path) => realpathSync.native(path),
    readBundleValue: readPlistValue,
    frontmostPid: getFrontmostApplicationPid,
    gameApiOnline: isLeagueGameApiOnline,
    signal: (pid, signal) => process.kill(pid, signal),
  };
}

function sameStartTime(
  left: ProcessStartTime,
  right: ProcessStartTime
): boolean {
  return (
    left.seconds === right.seconds &&
    left.microseconds === right.microseconds
  );
}

function getLeagueBundlePath(
  canonicalExecutablePath: string
): string | undefined {
  const marker = "/Contents/MacOS/";
  const markerIndex = canonicalExecutablePath.lastIndexOf(marker);
  if (markerIndex <= 0) {
    return undefined;
  }

  const bundlePath = canonicalExecutablePath.slice(0, markerIndex);
  const executableName = canonicalExecutablePath.slice(
    markerIndex + marker.length
  );
  if (
    !bundlePath.endsWith(".app") ||
    !executableName ||
    executableName.includes("/")
  ) {
    return undefined;
  }

  const gameDirectory = dirname(bundlePath);
  const lolDirectory = dirname(gameDirectory);
  const contentsDirectory = dirname(lolDirectory);
  if (
    basename(gameDirectory) !== "Game" ||
    basename(lolDirectory) !== "LoL" ||
    basename(contentsDirectory) !== "Contents"
  ) {
    return undefined;
  }
  return bundlePath;
}

async function validateLeagueSnapshot(
  snapshot: MacOSProcessSnapshot,
  dependencies: LeagueProcessDependencies
): Promise<LeagueGameProcessIdentity | undefined> {
  if (snapshot.uid !== dependencies.currentUid()) {
    return undefined;
  }

  let executablePath: string;
  try {
    executablePath = dependencies.canonicalizePath(
      snapshot.executablePath
    );
  } catch {
    return undefined;
  }
  const bundlePath = getLeagueBundlePath(executablePath);
  if (!bundlePath) {
    return undefined;
  }

  const plistPath = join(bundlePath, "Contents", "Info.plist");
  let bundleId: string;
  let bundleExecutable: string;
  try {
    [bundleId, bundleExecutable] = await Promise.all([
      dependencies.readBundleValue(
        plistPath,
        "CFBundleIdentifier"
      ),
      dependencies.readBundleValue(
        plistPath,
        "CFBundleExecutable"
      ),
    ]);
  } catch {
    return undefined;
  }

  if (
    bundleId !== LEAGUE_GAME_BUNDLE_ID ||
    bundleExecutable !== basename(executablePath)
  ) {
    return undefined;
  }

  let expectedExecutablePath: string;
  try {
    expectedExecutablePath = dependencies.canonicalizePath(
      join(bundlePath, "Contents", "MacOS", bundleExecutable)
    );
  } catch {
    return undefined;
  }
  if (expectedExecutablePath !== executablePath) {
    return undefined;
  }

  return {
    ...snapshot,
    executablePath,
    bundlePath,
  };
}

export async function resolveLeagueCaptureOwner(
  dependencies: LeagueProcessDependencies =
    createDefaultLeagueProcessDependencies()
): Promise<LeagueGameProcessIdentity | undefined> {
  const candidates = (
    await Promise.all(
      dependencies.processSource
        .list()
        .map((snapshot) =>
          validateLeagueSnapshot(snapshot, dependencies)
        )
    )
  ).filter(
    (candidate): candidate is LeagueGameProcessIdentity =>
      candidate !== undefined
  );

  if (candidates.length !== 1) {
    return undefined;
  }
  const candidate = candidates[0];
  if (!candidate) {
    return undefined;
  }
  if (
    dependencies.frontmostPid() !== candidate.pid ||
    !(await dependencies.gameApiOnline())
  ) {
    return undefined;
  }
  return candidate;
}

export function signalLeagueGameProcess(
  identity: LeagueGameProcessIdentity,
  signal: NodeJS.Signals,
  dependencies: LeagueProcessDependencies =
    createDefaultLeagueProcessDependencies()
): void {
  const current = dependencies.processSource.get(identity.pid);
  let currentExecutablePath: string | undefined;
  try {
    currentExecutablePath = current
      ? dependencies.canonicalizePath(current.executablePath)
      : undefined;
  } catch {
    currentExecutablePath = undefined;
  }
  if (
    !current ||
    current.uid !== identity.uid ||
    currentExecutablePath !== identity.executablePath ||
    !sameStartTime(current.startTime, identity.startTime)
  ) {
    throw new Error(
      `League game process ${identity.pid} changed before ${signal}`
    );
  }
  dependencies.signal(identity.pid, signal);
}
