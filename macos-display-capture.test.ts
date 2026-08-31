import { describe, expect, it, vi } from "vitest";
import {
  DisplayCaptureReleaseTimeoutError,
  isAnyDisplayCaptured,
  releaseCapturedDisplayForLock,
  type CoreGraphicsFunctions,
  type CoreGraphicsLoader,
  type Delay,
  type DisplayCaptureProbe,
} from "./macos-display-capture.ts";

function createCoreGraphicsLoader(
  functions: CoreGraphicsFunctions,
  close = vi.fn()
): { loadLibrary: CoreGraphicsLoader; close: typeof close } {
  return {
    loadLibrary: () => ({ lib: { close }, functions }),
    close,
  };
}

describe("isAnyDisplayCaptured", () => {
  if (process.platform === "darwin") {
    it("queries the real CoreGraphics display-capture state", () => {
      expect(isAnyDisplayCaptured()).toBeTypeOf("boolean");
    });
  }

  it("checks every online display and detects a capture", () => {
    const getOnlineDisplayList = vi
      .fn<CoreGraphicsFunctions["CGGetOnlineDisplayList"]>()
      .mockImplementationOnce((_maxDisplays, _displays, count) => {
        count[0] = 2;
        return 0;
      })
      .mockImplementationOnce((_maxDisplays, displays, count) => {
        if (displays) {
          displays[0] = 101;
          displays[1] = 202;
        }
        count[0] = 2;
        return 0;
      });
    const isCaptured = vi.fn((display: number) =>
      display === 202 ? 1 : 0
    );
    const { loadLibrary, close } = createCoreGraphicsLoader({
      CGGetOnlineDisplayList: getOnlineDisplayList,
      CGDisplayIsCaptured: isCaptured,
    });

    expect(isAnyDisplayCaptured(loadLibrary)).toBe(true);
    expect(isCaptured).toHaveBeenCalledWith(101);
    expect(isCaptured).toHaveBeenCalledWith(202);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("returns false without a second call when no displays are online", () => {
    const getOnlineDisplayList = vi.fn(
      (
        _maxDisplays: number,
        _displays: Uint32Array | null,
        count: Uint32Array
      ) => {
        count[0] = 0;
        return 0;
      }
    );
    const isCaptured = vi.fn(() => 0);
    const { loadLibrary, close } = createCoreGraphicsLoader({
      CGGetOnlineDisplayList: getOnlineDisplayList,
      CGDisplayIsCaptured: isCaptured,
    });

    expect(isAnyDisplayCaptured(loadLibrary)).toBe(false);
    expect(getOnlineDisplayList).toHaveBeenCalledTimes(1);
    expect(isCaptured).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("bounds a display-count increase to the allocated buffer", () => {
    const getOnlineDisplayList = vi
      .fn<CoreGraphicsFunctions["CGGetOnlineDisplayList"]>()
      .mockImplementationOnce((_maxDisplays, _displays, count) => {
        count[0] = 1;
        return 0;
      })
      .mockImplementationOnce((_maxDisplays, displays, count) => {
        if (displays) {
          displays[0] = 303;
        }
        count[0] = 2;
        return 0;
      });
    const isCaptured = vi.fn(() => 0);
    const { loadLibrary } = createCoreGraphicsLoader({
      CGGetOnlineDisplayList: getOnlineDisplayList,
      CGDisplayIsCaptured: isCaptured,
    });

    expect(isAnyDisplayCaptured(loadLibrary)).toBe(false);
    expect(isCaptured).toHaveBeenCalledTimes(1);
    expect(isCaptured).toHaveBeenCalledWith(303);
  });

  it.each([
    ["count", 1],
    ["displays", 2],
  ])("closes CoreGraphics when the %s query fails", (_stage, failingCall) => {
    let call = 0;
    const getOnlineDisplayList = vi.fn(
      (
        _maxDisplays: number,
        displays: Uint32Array | null,
        count: Uint32Array
      ) => {
        call += 1;
        if (call === failingCall) {
          return 1001;
        }
        if (displays === null) {
          count[0] = 1;
        }
        return 0;
      }
    );
    const { loadLibrary, close } = createCoreGraphicsLoader({
      CGGetOnlineDisplayList: getOnlineDisplayList,
      CGDisplayIsCaptured: vi.fn(() => 0),
    });

    expect(() => isAnyDisplayCaptured(loadLibrary)).toThrow(
      "failed with CoreGraphics error 1001"
    );
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("releaseCapturedDisplayForLock", () => {
  it("does nothing when no online display is captured", async () => {
    const requestRelease = vi.fn(async () => {});
    const isCaptured = vi.fn(() => false);
    const wait = vi.fn<Delay>(async () => {});

    await releaseCapturedDisplayForLock(
      requestRelease,
      {},
      isCaptured,
      wait
    );

    expect(isCaptured).toHaveBeenCalledTimes(1);
    expect(requestRelease).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
  });

  it("requests release and waits until the capture clears", async () => {
    const requestRelease = vi.fn(async () => {});
    const captureStates = [true, true, false];
    const isCaptured = vi.fn<DisplayCaptureProbe>(
      () => captureStates.shift() ?? false
    );
    const wait = vi.fn<Delay>(async () => {});

    await releaseCapturedDisplayForLock(
      requestRelease,
      { timeoutMs: 100, pollIntervalMs: 50 },
      isCaptured,
      wait
    );

    expect(requestRelease).toHaveBeenCalledTimes(1);
    expect(isCaptured).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledWith(50);
  });

  it("runs the pre-request snapshot only after capture is detected", async () => {
    const beforeRequest = vi.fn(async () => {});
    const requestRelease = vi.fn(async () => {});

    await releaseCapturedDisplayForLock(
      requestRelease,
      { beforeRequest },
      () => false
    );
    expect(beforeRequest).not.toHaveBeenCalled();

    const captureStates = [true, false];
    await releaseCapturedDisplayForLock(
      requestRelease,
      { beforeRequest },
      () => captureStates.shift() ?? false
    );
    expect(beforeRequest).toHaveBeenCalledTimes(1);
    expect(beforeRequest.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(
      requestRelease.mock.invocationCallOrder[0] ?? -Infinity
    );
  });

  it("fails instead of reporting a false lock success when capture persists", async () => {
    const requestRelease = vi.fn(async () => {});
    const isCaptured = vi.fn(() => true);
    const wait = vi.fn<Delay>(async () => {});

    await expect(
      releaseCapturedDisplayForLock(
        requestRelease,
        {
          timeoutMs: 100,
          pollIntervalMs: 50,
          requestDescription: "activating Finder",
        },
        isCaptured,
        wait
      )
    ).rejects.toEqual(
      new DisplayCaptureReleaseTimeoutError(100, "activating Finder")
    );

    expect(requestRelease).toHaveBeenCalledTimes(1);
    expect(isCaptured).toHaveBeenCalledTimes(4);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("propagates a failure to request capture release", async () => {
    const requestRelease = vi.fn(async () => {
      throw new Error("Finder activation failed");
    });
    const isCaptured = vi.fn(() => true);
    const wait = vi.fn<Delay>(async () => {});

    await expect(
      releaseCapturedDisplayForLock(
        requestRelease,
        {},
        isCaptured,
        wait
      )
    ).rejects.toThrow("Finder activation failed");

    expect(wait).not.toHaveBeenCalled();
  });

  it("accepts a request failure when capture cleared concurrently", async () => {
    const requestRelease = vi.fn(async () => {
      throw new Error("No matching process");
    });
    const captureStates = [true, false];
    const isCaptured = vi.fn(
      () => captureStates.shift() ?? false
    );
    const wait = vi.fn<Delay>(async () => {});

    await releaseCapturedDisplayForLock(
      requestRelease,
      {},
      isCaptured,
      wait
    );

    expect(requestRelease).toHaveBeenCalledTimes(1);
    expect(isCaptured).toHaveBeenCalledTimes(2);
    expect(wait).not.toHaveBeenCalled();
  });
});
