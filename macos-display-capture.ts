import { dlopen } from "node:ffi";

export const CORE_GRAPHICS_FRAMEWORK_PATH =
  "/System/Library/Frameworks/CoreGraphics.framework/Versions/Current/CoreGraphics";

const CORE_GRAPHICS_SYMBOLS = {
  CGGetOnlineDisplayList: {
    arguments: ["u32", "buffer", "buffer"],
    return: "i32",
  },
  CGDisplayIsCaptured: {
    arguments: ["u32"],
    return: "i32",
  },
} as const;

export const DISPLAY_CAPTURE_RELEASE_TIMEOUT_MS = 5_000;
export const DISPLAY_CAPTURE_POLL_INTERVAL_MS = 50;

export type DisplayCaptureProbe = () => boolean;
export type DisplayCaptureReleaseRequester = () => Promise<void>;
export type Delay = (milliseconds: number) => Promise<void>;
export type CoreGraphicsFunctions = {
  CGGetOnlineDisplayList: (
    maxDisplays: number,
    onlineDisplays: Uint32Array | null,
    displayCount: Uint32Array
  ) => number;
  CGDisplayIsCaptured: (display: number) => number;
};
export type CoreGraphicsLibrary = {
  lib: { close: () => void };
  functions: CoreGraphicsFunctions;
};
export type CoreGraphicsLoader = () => CoreGraphicsLibrary;

const delay: Delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function throwForCoreGraphicsError(operation: string, result: number): void {
  if (result !== 0) {
    throw new Error(`${operation} failed with CoreGraphics error ${result}`);
  }
}

const loadCoreGraphics: CoreGraphicsLoader = () =>
  dlopen(
    CORE_GRAPHICS_FRAMEWORK_PATH,
    CORE_GRAPHICS_SYMBOLS
  ) as unknown as CoreGraphicsLibrary;

/**
 * Returns whether any online display is exclusively captured by an
 * application. CGDisplayIsCaptured is deprecated but remains the public query
 * that corresponds to CGDisplayCapture, which League currently uses.
 */
export function isAnyDisplayCaptured(
  loadLibrary: CoreGraphicsLoader = loadCoreGraphics
): boolean {
  const { lib, functions } = loadLibrary();

  try {
    const displayCount = new Uint32Array(1);
    throwForCoreGraphicsError(
      "CGGetOnlineDisplayList(count)",
      functions.CGGetOnlineDisplayList(0, null, displayCount)
    );

    const onlineDisplayCount = displayCount[0] ?? 0;
    if (onlineDisplayCount === 0) {
      return false;
    }

    const displays = new Uint32Array(onlineDisplayCount);
    throwForCoreGraphicsError(
      "CGGetOnlineDisplayList(displays)",
      functions.CGGetOnlineDisplayList(
        displays.length,
        displays,
        displayCount
      )
    );

    const returnedDisplayCount = Math.min(
      displayCount[0] ?? 0,
      displays.length
    );
    return displays
      .subarray(0, returnedDisplayCount)
      .some((display) => functions.CGDisplayIsCaptured(display) !== 0);
  } finally {
    lib.close();
  }
}

/**
 * Ask the foreground application to relinquish an exclusive display capture,
 * then wait for WindowServer to confirm the release. The capture belongs to
 * that application, so this deliberately does not call CGDisplayRelease from
 * the agent process.
 */
export async function releaseCapturedDisplayForLock(
  requestRelease: DisplayCaptureReleaseRequester,
  isCaptured: DisplayCaptureProbe = isAnyDisplayCaptured,
  wait: Delay = delay,
  timeoutMs = DISPLAY_CAPTURE_RELEASE_TIMEOUT_MS,
  pollIntervalMs = DISPLAY_CAPTURE_POLL_INTERVAL_MS
): Promise<void> {
  if (!isCaptured()) {
    return;
  }

  await requestRelease();

  const pollCount = Math.ceil(timeoutMs / pollIntervalMs);
  for (let poll = 0; poll <= pollCount; poll += 1) {
    if (!isCaptured()) {
      return;
    }

    if (poll < pollCount) {
      await wait(pollIntervalMs);
    }
  }

  throw new Error(
    `Display remained captured ${timeoutMs}ms after activating Finder`
  );
}

/** Resolve the capture-query symbols without capturing or changing a display. */
export function verifyDisplayCaptureSupport(
  loadLibrary: CoreGraphicsLoader = loadCoreGraphics
): void {
  const { lib } = loadLibrary();
  lib.close();
}
