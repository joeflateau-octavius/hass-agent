/**
 * Allowlisted macOS commands exposed through Home Assistant.
 *
 * Commands are defined as executable/argument pairs and never pass through a
 * shell. This keeps MQTT payloads from becoming an arbitrary command surface.
 */

import { dlopen } from "node:ffi";
import { spawn } from "child_process";
import type { MqttCommandDefinition } from "./mqtt-emitter.ts";
import {
  DisplayCaptureReleaseTimeoutError,
  releaseCapturedDisplayForLock,
  verifyDisplayCaptureSupport,
  type DisplayCaptureReleaseOptions,
  type DisplayCaptureReleaseRequester,
} from "./macos-display-capture.ts";
import {
  resolveLeagueCaptureOwner,
  signalLeagueGameProcess,
  type LeagueGameProcessIdentity,
} from "./macos-league-process.ts";

export const RETIRED_MACOS_COMMAND_IDS = ["start_screensaver"] as const;
export const LOGIN_FRAMEWORK_PATH =
  "/System/Library/PrivateFrameworks/login.framework/Versions/Current/login";
export const OPEN_APPLICATION_PATH = "/usr/bin/open";
export const FINDER_BUNDLE_ID = "com.apple.finder";
export const LEAGUE_GAME_TERM_TIMEOUT_MS = 3_000;
export const LEAGUE_GAME_KILL_TIMEOUT_MS = 2_000;
const LOGIN_FRAMEWORK_SYMBOLS = {
  SACLockScreenImmediate: {
    arguments: [],
    return: "i32",
  },
} as const;

export type ProcessRunner = (
  executable: string,
  args: readonly string[]
) => Promise<void>;

export type ScreenLocker = () => Promise<void>;
export type NativeScreenLocker = () => void;
export type DisplayCaptureReleaser = (
  requestRelease: DisplayCaptureReleaseRequester,
  options?: DisplayCaptureReleaseOptions
) => Promise<void>;
export type LeagueCaptureOwnerResolver = () => Promise<
  LeagueGameProcessIdentity | undefined
>;
export type LeagueProcessSignaler = (
  identity: LeagueGameProcessIdentity,
  signal: NodeJS.Signals
) => void;

export async function runProcess(
  executable: string,
  args: readonly string[]
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      const detail = stderr.trim();
      reject(
        new Error(
          `${executable} exited with code ${code}${detail ? `: ${detail}` : ""}`
        )
      );
    });

    child.on("error", reject);
  });
}

function callNativeLockScreen(): void {
  const { lib, functions } = dlopen(
    LOGIN_FRAMEWORK_PATH,
    LOGIN_FRAMEWORK_SYMBOLS
  );

  try {
    const result = functions.SACLockScreenImmediate();
    if (result !== 0) {
      throw new Error(`SACLockScreenImmediate failed with code ${result}`);
    }
  } finally {
    lib.close();
  }
}

export async function lockScreen(
  runner: ProcessRunner = runProcess,
  releaseDisplayCapture: DisplayCaptureReleaser =
    releaseCapturedDisplayForLock,
  nativeScreenLocker: NativeScreenLocker = callNativeLockScreen,
  resolveLeagueOwner: LeagueCaptureOwnerResolver =
    resolveLeagueCaptureOwner,
  signalLeagueProcess: LeagueProcessSignaler =
    signalLeagueGameProcess
): Promise<void> {
  let leagueCaptureOwner: LeagueGameProcessIdentity | undefined;
  let leagueOwnerResolutionError: unknown;
  try {
    await releaseDisplayCapture(
      () => runner(OPEN_APPLICATION_PATH, ["-b", FINDER_BUNDLE_ID]),
      {
        requestDescription: "activating Finder",
        beforeRequest: async () => {
          try {
            leagueCaptureOwner = await resolveLeagueOwner();
          } catch (error) {
            leagueOwnerResolutionError = error;
          }
        },
      }
    );
  } catch (error) {
    if (!(error instanceof DisplayCaptureReleaseTimeoutError)) {
      throw error;
    }
    if (!leagueCaptureOwner) {
      const verificationDetail =
        leagueOwnerResolutionError instanceof Error
          ? `: ${leagueOwnerResolutionError.message}`
          : "";
      throw new Error(
        `${error.message}; League termination skipped because the captured display owner could not be verified${verificationDetail}`,
        { cause: error }
      );
    }

    try {
      await releaseDisplayCapture(
        async () =>
          signalLeagueProcess(leagueCaptureOwner!, "SIGTERM"),
        {
          timeoutMs: LEAGUE_GAME_TERM_TIMEOUT_MS,
          requestDescription:
            "terminating the League of Legends game",
        }
      );
    } catch (terminationError) {
      if (
        !(
          terminationError instanceof DisplayCaptureReleaseTimeoutError
        )
      ) {
        throw terminationError;
      }

      await releaseDisplayCapture(
        async () =>
          signalLeagueProcess(leagueCaptureOwner!, "SIGKILL"),
        {
          timeoutMs: LEAGUE_GAME_KILL_TIMEOUT_MS,
          requestDescription:
            "force-terminating the League of Legends game",
        }
      );
    }
  }

  nativeScreenLocker();
}

/**
 * Verify that the private macOS lock function is still available without
 * invoking it (which would lock the test runner).
 */
export function verifyLockScreenSupport(): void {
  const { lib } = dlopen(LOGIN_FRAMEWORK_PATH, LOGIN_FRAMEWORK_SYMBOLS);
  lib.close();
  verifyDisplayCaptureSupport();
}

export function createMacOSCommands(
  runner: ProcessRunner = runProcess,
  screenLocker: ScreenLocker = () => lockScreen(runner)
): MqttCommandDefinition[] {
  return [
    {
      id: "lock_screen",
      name: "Lock Screen",
      icon: "mdi:lock",
      execute: screenLocker,
    },
    {
      id: "sleep_display",
      name: "Sleep Display",
      icon: "mdi:monitor-off",
      execute: () => runner("/usr/bin/pmset", ["displaysleepnow"]),
    },
  ];
}
