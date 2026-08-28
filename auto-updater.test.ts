import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as winston from "winston";
import { AutoUpdater, type AutoUpdaterConfig } from "./auto-updater.ts";

const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({
  spawn: mockSpawn,
}));

describe("AutoUpdater", () => {
  let logger: winston.Logger;
  let config: AutoUpdaterConfig;
  let autoUpdater: AutoUpdater;

  beforeEach(() => {
    // Create a silent logger for testing
    logger = winston.createLogger({
      level: "error",
      transports: [new winston.transports.Console({ silent: true })],
    });

    config = {
      autoUpgrade: true,
      upgradeCheckInterval: 1000, // 1 second for faster testing
      installScriptUrl: "https://example.com/install.sh",
      version: "1.0.0",
    };

    autoUpdater = new AutoUpdater(config, logger);
  });

  afterEach(() => {
    autoUpdater.stop();
    mockSpawn.mockClear();
  });

  it("should not start upgrade checks when autoUpgrade is false", () => {
    const configWithoutUpgrade = { ...config, autoUpgrade: false };
    const updater = new AutoUpdater(configWithoutUpgrade, logger);

    updater.start();

    expect(mockSpawn).not.toHaveBeenCalled();
    updater.stop();
  });

  it("should not start upgrade checks when version is development", () => {
    const configWithDevelopment = { ...config, version: "development" };
    const updater = new AutoUpdater(configWithDevelopment, logger);

    updater.start();

    expect(mockSpawn).not.toHaveBeenCalled();
    updater.stop();
  });

  it("should start upgrade checks when conditions are met", async () => {
    // Mock spawn to return a successful process
    const mockChild = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn((event, callback) => {
        if (event === "close") {
          // Simulate successful command execution
          setTimeout(() => callback(0), 10);
        }
      }),
    };

    mockSpawn.mockReturnValue(mockChild);

    autoUpdater.start();

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      "sh",
      ["-c", expect.stringContaining("curl -fsSL")],
      expect.any(Object)
    );
  });

  it("should stop upgrade checks when stop is called", () => {
    autoUpdater.start();
    autoUpdater.stop();

    // Should not crash or throw errors
    expect(true).toBe(true);
  });

  it("should handle multiple stop calls gracefully", () => {
    autoUpdater.start();
    autoUpdater.stop();
    autoUpdater.stop(); // Second call should not cause issues

    expect(true).toBe(true);
  });

  it("enables upgrade checks immediately at runtime", async () => {
    const updater = new AutoUpdater({ ...config, autoUpgrade: false }, logger);
    const mockChild = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
    };
    mockSpawn.mockReturnValue(mockChild);

    updater.setEnabled(true);
    await Promise.resolve();

    expect(updater.isEnabled()).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    updater.stop();
  });

  it("stops future upgrade checks when disabled at runtime", () => {
    vi.useFakeTimers();
    const mockChild = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
    };
    mockSpawn.mockReturnValue(mockChild);

    autoUpdater.start();
    autoUpdater.setEnabled(false);
    vi.advanceTimersByTime(config.upgradeCheckInterval * 2);

    expect(autoUpdater.isEnabled()).toBe(false);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("does not create duplicate timers when enabled repeatedly", async () => {
    vi.useFakeTimers();
    const mockChild = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn((event, callback) => {
        if (event === "close") callback(0);
      }),
    };
    mockSpawn.mockReturnValue(mockChild);

    autoUpdater.start();
    autoUpdater.start();
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(config.upgradeCheckInterval);

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("reschedules future checks without checking immediately when interval changes", async () => {
    vi.useFakeTimers();
    mockSpawn.mockReturnValue({
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn((event, callback) => {
        if (event === "close") callback(0);
      }),
    });

    autoUpdater.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    autoUpdater.setCheckInterval(2000);
    expect(autoUpdater.getCheckInterval()).toBe(2000);
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1999);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("stores an interval change without starting checks while disabled", () => {
    vi.useFakeTimers();
    const updater = new AutoUpdater(
      { ...config, autoUpgrade: false },
      logger
    );

    updater.setCheckInterval(2000);
    vi.advanceTimersByTime(4000);

    expect(updater.getCheckInterval()).toBe(2000);
    expect(mockSpawn).not.toHaveBeenCalled();
    updater.stop();
    vi.useRealTimers();
  });

  it("does not overlap upgrade checks", () => {
    vi.useFakeTimers();
    mockSpawn.mockReturnValue({
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
    });

    autoUpdater.start();
    vi.advanceTimersByTime(config.upgradeCheckInterval * 2);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
