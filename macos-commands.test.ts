import { describe, expect, it, vi } from "vitest";
import {
  createMacOSCommands,
  FINDER_BUNDLE_ID,
  LEAGUE_GAME_KILL_TIMEOUT_MS,
  LEAGUE_GAME_TERM_TIMEOUT_MS,
  lockScreen,
  OPEN_APPLICATION_PATH,
  RETIRED_MACOS_COMMAND_IDS,
  verifyLockScreenSupport,
} from "./macos-commands.ts";
import {
  DisplayCaptureReleaseTimeoutError,
  releaseCapturedDisplayForLock,
} from "./macos-display-capture.ts";
import type { LeagueGameProcessIdentity } from "./macos-league-process.ts";

const leagueIdentity: LeagueGameProcessIdentity = {
  pid: 4242,
  uid: 501,
  executablePath:
    "/Applications/League of Legends.app/Contents/LoL/Game/League of Legends.app/Contents/MacOS/LeagueofLegends",
  bundlePath:
    "/Applications/League of Legends.app/Contents/LoL/Game/League of Legends.app",
  startTime: { seconds: 100n, microseconds: 200n },
};

describe("createMacOSCommands", () => {
  if (process.platform === "darwin") {
    it("finds the native macOS lock function without invoking it", () => {
      expect(verifyLockScreenSupport).not.toThrow();
    });
  }

  it("defines the safe macOS command allowlist", () => {
    const commands = createMacOSCommands(vi.fn(async () => {}));

    expect(commands.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "lock_screen", name: "Lock Screen" },
      { id: "sleep_display", name: "Sleep Display" },
    ]);
  });

  it("locks the session without AppleScript", async () => {
    const runner = vi.fn(async () => {});
    const screenLocker = vi.fn(async () => {});
    const command = createMacOSCommands(runner, screenLocker).find(
      ({ id }) => id === "lock_screen"
    );

    await command?.execute();

    expect(screenLocker).toHaveBeenCalledTimes(1);
    expect(runner).not.toHaveBeenCalled();
  });

  it("releases a captured display through Finder before locking", async () => {
    const runner = vi.fn(async () => {});
    const releaseDisplayCapture = vi.fn(async (requestRelease) => {
      await requestRelease();
    });
    const nativeScreenLocker = vi.fn(() => {});

    await lockScreen(runner, releaseDisplayCapture, nativeScreenLocker);

    expect(releaseDisplayCapture).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith(OPEN_APPLICATION_PATH, [
      "-b",
      FINDER_BUNDLE_ID,
    ]);
    expect(nativeScreenLocker).toHaveBeenCalledTimes(1);
    expect(runner.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(
      nativeScreenLocker.mock.invocationCallOrder[0] ?? -Infinity
    );
  });

  it("locks directly without activating Finder when no display is captured", async () => {
    const runner = vi.fn(async () => {});
    const nativeScreenLocker = vi.fn(() => {});
    const resolveLeagueOwner = vi.fn(async () => leagueIdentity);

    await lockScreen(
      runner,
      (requestRelease) =>
        releaseCapturedDisplayForLock(
          requestRelease,
          {},
          () => false
      ),
      nativeScreenLocker,
      resolveLeagueOwner
    );

    expect(runner).not.toHaveBeenCalled();
    expect(resolveLeagueOwner).not.toHaveBeenCalled();
    expect(nativeScreenLocker).toHaveBeenCalledTimes(1);
  });

  it("does not call the native lock function when capture release fails", async () => {
    const runner = vi.fn(async () => {});
    const releaseDisplayCapture = vi.fn(async () => {
      throw new Error("Display remained captured");
    });
    const nativeScreenLocker = vi.fn(() => {});

    await expect(
      lockScreen(runner, releaseDisplayCapture, nativeScreenLocker)
    ).rejects.toThrow("Display remained captured");

    expect(runner).not.toHaveBeenCalled();
    expect(nativeScreenLocker).not.toHaveBeenCalled();
  });

  it("refuses to terminate anything when the capture owner is not verified", async () => {
    const runner = vi.fn(async () => {});
    const releaseDisplayCapture = vi.fn(
      async (requestRelease, options) => {
        await options?.beforeRequest?.();
        await requestRelease();
        throw new DisplayCaptureReleaseTimeoutError(
          5_000,
          "activating Finder"
        );
      }
    );
    const nativeScreenLocker = vi.fn(() => {});
    const resolveLeagueOwner = vi.fn(async () => undefined);
    const signalLeagueProcess = vi.fn(() => {});

    await expect(
      lockScreen(
        runner,
        releaseDisplayCapture,
        nativeScreenLocker,
        resolveLeagueOwner,
        signalLeagueProcess
      )
    ).rejects.toThrow("captured display owner could not be verified");

    expect(runner).toHaveBeenCalledTimes(1);
    expect(resolveLeagueOwner).toHaveBeenCalledTimes(1);
    expect(signalLeagueProcess).not.toHaveBeenCalled();
    expect(nativeScreenLocker).not.toHaveBeenCalled();
  });

  it("terminates only the League game when Finder cannot release capture", async () => {
    const runner = vi.fn(async () => {});
    let releaseAttempt = 0;
    const releaseDisplayCapture = vi.fn(async (requestRelease, options) => {
      releaseAttempt += 1;
      await options?.beforeRequest?.();
      await requestRelease();
      if (releaseAttempt === 1) {
        throw new DisplayCaptureReleaseTimeoutError(
          5_000,
          "activating Finder"
        );
      }
    });
    const nativeScreenLocker = vi.fn(() => {});
    const resolveLeagueOwner = vi.fn(async () => leagueIdentity);
    const signalLeagueProcess = vi.fn(() => {});

    await lockScreen(
      runner,
      releaseDisplayCapture,
      nativeScreenLocker,
      resolveLeagueOwner,
      signalLeagueProcess
    );

    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith(OPEN_APPLICATION_PATH, [
      "-b",
      FINDER_BUNDLE_ID,
    ]);
    expect(signalLeagueProcess).toHaveBeenCalledWith(
      leagueIdentity,
      "SIGTERM"
    );
    expect(releaseDisplayCapture).toHaveBeenNthCalledWith(
      2,
      expect.any(Function),
      {
        timeoutMs: LEAGUE_GAME_TERM_TIMEOUT_MS,
        requestDescription:
          "terminating the League of Legends game",
      }
    );
    expect(nativeScreenLocker).toHaveBeenCalledTimes(1);
  });

  it("force-terminates the League game if it ignores SIGTERM", async () => {
    const runner = vi.fn(async () => {});
    let releaseAttempt = 0;
    const releaseDisplayCapture = vi.fn(async (requestRelease, options) => {
      releaseAttempt += 1;
      await options?.beforeRequest?.();
      await requestRelease();
      if (releaseAttempt <= 2) {
        throw new DisplayCaptureReleaseTimeoutError(
          releaseAttempt === 1
            ? 5_000
            : LEAGUE_GAME_TERM_TIMEOUT_MS,
          releaseAttempt === 1
            ? "activating Finder"
            : "terminating the League of Legends game"
        );
      }
    });
    const nativeScreenLocker = vi.fn(() => {});
    const signalLeagueProcess = vi.fn(() => {});

    await lockScreen(
      runner,
      releaseDisplayCapture,
      nativeScreenLocker,
      async () => leagueIdentity,
      signalLeagueProcess
    );

    expect(signalLeagueProcess.mock.calls).toEqual([
      [leagueIdentity, "SIGTERM"],
      [leagueIdentity, "SIGKILL"],
    ]);
    expect(releaseDisplayCapture).toHaveBeenNthCalledWith(
      3,
      expect.any(Function),
      {
        timeoutMs: LEAGUE_GAME_KILL_TIMEOUT_MS,
        requestDescription:
          "force-terminating the League of Legends game",
      }
    );
    expect(nativeScreenLocker).toHaveBeenCalledTimes(1);
  });

  it("does not lock when the League termination request fails", async () => {
    const runner = vi.fn(async () => {});
    let releaseAttempt = 0;
    const releaseDisplayCapture = vi.fn(async (requestRelease, options) => {
      releaseAttempt += 1;
      await options?.beforeRequest?.();
      await requestRelease();
      throw new DisplayCaptureReleaseTimeoutError(
        5_000,
        "activating Finder"
      );
    });
    const nativeScreenLocker = vi.fn(() => {});
    const signalLeagueProcess = vi.fn(() => {
      throw new Error("League game process changed before SIGTERM");
    });

    await expect(
      lockScreen(
        runner,
        releaseDisplayCapture,
        nativeScreenLocker,
        async () => leagueIdentity,
        signalLeagueProcess
      )
    ).rejects.toThrow("League game process changed before SIGTERM");

    expect(signalLeagueProcess).toHaveBeenCalledWith(
      leagueIdentity,
      "SIGTERM"
    );
    expect(nativeScreenLocker).not.toHaveBeenCalled();
  });

  it("does not report lock success when forced termination leaves capture active", async () => {
    const runner = vi.fn(async () => {});
    let releaseAttempt = 0;
    const releaseDisplayCapture = vi.fn(async (requestRelease, options) => {
      releaseAttempt += 1;
      await options?.beforeRequest?.();
      await requestRelease();
      throw new DisplayCaptureReleaseTimeoutError(
        releaseAttempt === 1
          ? 5_000
          : releaseAttempt === 2
            ? LEAGUE_GAME_TERM_TIMEOUT_MS
            : LEAGUE_GAME_KILL_TIMEOUT_MS,
        releaseAttempt === 1
          ? "activating Finder"
          : releaseAttempt === 2
            ? "terminating the League of Legends game"
            : "force-terminating the League of Legends game"
      );
    });
    const nativeScreenLocker = vi.fn(() => {});
    const signalLeagueProcess = vi.fn(() => {});

    await expect(
      lockScreen(
        runner,
        releaseDisplayCapture,
        nativeScreenLocker,
        async () => leagueIdentity,
        signalLeagueProcess
      )
    ).rejects.toThrow(
      `Display remained captured ${LEAGUE_GAME_KILL_TIMEOUT_MS}ms after force-terminating the League of Legends game`
    );

    expect(signalLeagueProcess.mock.calls).toEqual([
      [leagueIdentity, "SIGTERM"],
      [leagueIdentity, "SIGKILL"],
    ]);
    expect(nativeScreenLocker).not.toHaveBeenCalled();
  });

  it("sleeps the display with pmset", async () => {
    const runner = vi.fn(async () => {});
    const command = createMacOSCommands(runner).find(
      ({ id }) => id === "sleep_display"
    );

    await command?.execute();

    expect(runner).toHaveBeenCalledWith("/usr/bin/pmset", ["displaysleepnow"]);
  });

  it("retires the removed command ids", () => {
    expect(RETIRED_MACOS_COMMAND_IDS).toEqual(["start_screensaver"]);
  });
});
