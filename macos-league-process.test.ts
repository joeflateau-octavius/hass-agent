import { describe, expect, it, vi } from "vitest";
import {
  LEAGUE_GAME_BUNDLE_ID,
  resolveLeagueCaptureOwner,
  signalLeagueGameProcess,
  type LeagueGameProcessIdentity,
  type LeagueProcessDependencies,
  type MacOSProcessSnapshot,
} from "./macos-league-process.ts";

const gameExecutablePath =
  "/Users/jotham/Games/League of Legends.app/Contents/LoL/Game/League of Legends.app/Contents/MacOS/LeagueofLegends";

function createSnapshot(
  overrides: Partial<MacOSProcessSnapshot> = {}
): MacOSProcessSnapshot {
  return {
    pid: 4242,
    uid: 501,
    executablePath: gameExecutablePath,
    startTime: { seconds: 100n, microseconds: 200n },
    ...overrides,
  };
}

function createDependencies(
  snapshots: MacOSProcessSnapshot[],
  overrides: Partial<LeagueProcessDependencies> = {}
): LeagueProcessDependencies {
  return {
    processSource: {
      list: vi.fn(() => snapshots),
      get: vi.fn((pid) =>
        snapshots.find((snapshot) => snapshot.pid === pid)
      ),
    },
    currentUid: vi.fn(() => 501),
    canonicalizePath: vi.fn((path) => path),
    readBundleValue: vi.fn(async (_plistPath, key) =>
      key === "CFBundleIdentifier"
        ? LEAGUE_GAME_BUNDLE_ID
        : "LeagueofLegends"
    ),
    frontmostPid: vi.fn(() => 4242),
    gameApiOnline: vi.fn(async () => true),
    signal: vi.fn(() => {}),
    ...overrides,
  };
}

describe("resolveLeagueCaptureOwner", () => {
  it("accepts one foreground game process from a verified Riot game bundle", async () => {
    const snapshot = createSnapshot();
    const dependencies = createDependencies([snapshot]);

    await expect(
      resolveLeagueCaptureOwner(dependencies)
    ).resolves.toEqual({
      ...snapshot,
      bundlePath:
        "/Users/jotham/Games/League of Legends.app/Contents/LoL/Game/League of Legends.app",
    });
    expect(dependencies.gameApiOnline).toHaveBeenCalledTimes(1);
  });

  it("supports the alternate LeagueOfLegends inner bundle spelling", async () => {
    const snapshot = createSnapshot({
      executablePath: gameExecutablePath.replace(
        "/Game/League of Legends.app/",
        "/Game/LeagueOfLegends.app/"
      ),
    });

    await expect(
      resolveLeagueCaptureOwner(createDependencies([snapshot]))
    ).resolves.toMatchObject({ pid: snapshot.pid });
  });

  it("rejects a fake process with the League basename outside the Riot game bundle", async () => {
    const snapshot = createSnapshot({
      executablePath: "/tmp/LeagueofLegends",
    });
    const readBundleValue = vi.fn(async () => "unexpected");

    await expect(
      resolveLeagueCaptureOwner(
        createDependencies([snapshot], { readBundleValue })
      )
    ).resolves.toBeUndefined();
    expect(readBundleValue).not.toHaveBeenCalled();
  });

  it("never mistakes League Client UX for the in-game process", async () => {
    const snapshot = createSnapshot({
      executablePath:
        "/Applications/League of Legends.app/Contents/LoL/LeagueClient.app/Contents/MacOS/LeagueClientUx",
    });

    await expect(
      resolveLeagueCaptureOwner(createDependencies([snapshot]))
    ).resolves.toBeUndefined();
  });

  it("rejects the wrong bundle identifier or executable", async () => {
    const snapshot = createSnapshot();
    const wrongBundle = createDependencies([snapshot], {
      readBundleValue: vi.fn(async (_path, key) =>
        key === "CFBundleIdentifier"
          ? "com.example.fake"
          : "LeagueofLegends"
      ),
    });
    const wrongExecutable = createDependencies([snapshot], {
      readBundleValue: vi.fn(async (_path, key) =>
        key === "CFBundleIdentifier"
          ? LEAGUE_GAME_BUNDLE_ID
          : "LeagueClientUx"
      ),
    });

    await expect(
      resolveLeagueCaptureOwner(wrongBundle)
    ).resolves.toBeUndefined();
    await expect(
      resolveLeagueCaptureOwner(wrongExecutable)
    ).resolves.toBeUndefined();
  });

  it("refuses zero or multiple matching game processes", async () => {
    await expect(
      resolveLeagueCaptureOwner(createDependencies([]))
    ).resolves.toBeUndefined();

    const first = createSnapshot();
    const second = createSnapshot({ pid: 4243 });
    await expect(
      resolveLeagueCaptureOwner(
        createDependencies([first, second], {
          frontmostPid: vi.fn(() => first.pid),
        })
      )
    ).resolves.toBeUndefined();
  });

  it("refuses a background League game when another app is frontmost", async () => {
    const snapshot = createSnapshot();

    await expect(
      resolveLeagueCaptureOwner(
        createDependencies([snapshot], {
          frontmostPid: vi.fn(() => 9999),
        })
      )
    ).resolves.toBeUndefined();
  });

  it("requires a fresh successful Game Client API probe", async () => {
    const snapshot = createSnapshot();

    await expect(
      resolveLeagueCaptureOwner(
        createDependencies([snapshot], {
          gameApiOnline: vi.fn(async () => false),
        })
      )
    ).resolves.toBeUndefined();
  });

  it("rejects a matching process owned by another user", async () => {
    const snapshot = createSnapshot({ uid: 502 });

    await expect(
      resolveLeagueCaptureOwner(createDependencies([snapshot]))
    ).resolves.toBeUndefined();
  });
});

describe("signalLeagueGameProcess", () => {
  function createIdentity(
    snapshot: MacOSProcessSnapshot
  ): LeagueGameProcessIdentity {
    return {
      ...snapshot,
      bundlePath:
        "/Users/jotham/Games/League of Legends.app/Contents/LoL/Game/League of Legends.app",
    };
  }

  it("signals only the exact revalidated PID", () => {
    const snapshot = createSnapshot();
    const dependencies = createDependencies([snapshot]);

    signalLeagueGameProcess(
      createIdentity(snapshot),
      "SIGTERM",
      dependencies
    );

    expect(dependencies.signal).toHaveBeenCalledWith(
      snapshot.pid,
      "SIGTERM"
    );
  });

  it("does not signal a PID reused by another process", () => {
    const original = createSnapshot();
    const replacement = createSnapshot({
      startTime: { seconds: 101n, microseconds: 0n },
    });
    const dependencies = createDependencies([replacement]);

    expect(() =>
      signalLeagueGameProcess(
        createIdentity(original),
        "SIGKILL",
        dependencies
      )
    ).toThrow("changed before SIGKILL");
    expect(dependencies.signal).not.toHaveBeenCalled();
  });

  it("does not signal when the executable path or user changed", () => {
    const original = createSnapshot();
    const replacement = createSnapshot({
      uid: 502,
      executablePath: "/tmp/LeagueofLegends",
    });
    const dependencies = createDependencies([replacement]);

    expect(() =>
      signalLeagueGameProcess(
        createIdentity(original),
        "SIGKILL",
        dependencies
      )
    ).toThrow("changed before SIGKILL");
    expect(dependencies.signal).not.toHaveBeenCalled();
  });
});
