import { describe, expect, it, vi } from "vitest";
import {
  createMacOSCommands,
  RETIRED_MACOS_COMMAND_IDS,
  verifyLockScreenSupport,
} from "./macos-commands.ts";

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
