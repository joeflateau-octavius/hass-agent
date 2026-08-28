import { describe, expect, it, vi } from "vitest";
import {
  createMacOSCommands,
  FINDER_BUNDLE_ID,
  lockScreen,
  OPEN_APPLICATION_PATH,
  RETIRED_MACOS_COMMAND_IDS,
  verifyLockScreenSupport,
} from "./macos-commands.ts";
import { releaseCapturedDisplayForLock } from "./macos-display-capture.ts";

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

    await lockScreen(
      runner,
      (requestRelease) =>
        releaseCapturedDisplayForLock(requestRelease, () => false),
      nativeScreenLocker
    );

    expect(runner).not.toHaveBeenCalled();
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
