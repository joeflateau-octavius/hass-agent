import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface AutoUpgradeSettingsStore {
  load(fallback: boolean): Promise<boolean>;
  save(enabled: boolean): Promise<void>;
  loadInterval(fallback: number): Promise<number>;
  saveInterval(interval: number): Promise<void>;
}

interface ManagedSettings {
  autoUpgrade?: boolean;
  upgradeCheckInterval?: number;
  [key: string]: unknown;
}

const MAX_SETTINGS_BYTES = 64 * 1024;
export const MIN_UPGRADE_CHECK_INTERVAL = 15 * 60 * 1000;
export const MAX_UPGRADE_CHECK_INTERVAL = 7 * 24 * 60 * 60 * 1000;
export const UPGRADE_CHECK_INTERVAL_STEP = 15 * 60 * 1000;

class ManagedSettingsError extends Error {
  constructor(
    message: string,
    public readonly recoverable: boolean
  ) {
    super(message);
  }
}

function parseManagedSettings(contents: string, path: string): ManagedSettings {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new ManagedSettingsError(
      `Could not parse managed settings at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      true
    );
  }

  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new ManagedSettingsError(
      `Managed settings at ${path} must be a JSON object`,
      true
    );
  }

  const settings = value as ManagedSettings;
  if (
    settings.autoUpgrade !== undefined &&
    typeof settings.autoUpgrade !== "boolean"
  ) {
    throw new ManagedSettingsError(
      `Managed setting autoUpgrade at ${path} must be true or false`,
      true
    );
  }
  if (
    settings.upgradeCheckInterval !== undefined &&
    (!Number.isSafeInteger(settings.upgradeCheckInterval) ||
      settings.upgradeCheckInterval < MIN_UPGRADE_CHECK_INTERVAL ||
      settings.upgradeCheckInterval > MAX_UPGRADE_CHECK_INTERVAL ||
      settings.upgradeCheckInterval % UPGRADE_CHECK_INTERVAL_STEP !== 0)
  ) {
    throw new ManagedSettingsError(
      `Managed setting upgradeCheckInterval at ${path} must be a 15-minute increment between 15 minutes and 168 hours`,
      true
    );
  }

  return settings;
}

async function readManagedSettings(path: string): Promise<ManagedSettings> {
  const metadata = await lstat(path);
  if (!metadata.isFile()) {
    throw new ManagedSettingsError(
      `Managed settings path ${path} must be a regular file`,
      false
    );
  }
  if (metadata.size > MAX_SETTINGS_BYTES) {
    throw new ManagedSettingsError(
      `Managed settings at ${path} exceeds ${MAX_SETTINGS_BYTES} bytes`,
      false
    );
  }

  return parseManagedSettings(await readFile(path, "utf8"), path);
}

export class FileAutoUpgradeSettingsStore
  implements AutoUpgradeSettingsStore
{
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly path = ".settings.json",
    private readonly reportError: (message: string) => void = () => {}
  ) {}

  public async load(fallback: boolean): Promise<boolean> {
    try {
      return (await readManagedSettings(this.path)).autoUpgrade ?? fallback;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return fallback;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.reportError(`${message}; automatic upgrades are disabled`);
      return false;
    }
  }

  public async save(enabled: boolean): Promise<void> {
    await this.saveSetting("autoUpgrade", enabled);
  }

  public async loadInterval(fallback: number): Promise<number> {
    try {
      return (
        (await readManagedSettings(this.path)).upgradeCheckInterval ?? fallback
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return fallback;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.reportError(`${message}; using the environment-derived upgrade interval`);
      return fallback;
    }
  }

  public async saveInterval(interval: number): Promise<void> {
    if (
      !Number.isSafeInteger(interval) ||
      interval < MIN_UPGRADE_CHECK_INTERVAL ||
      interval > MAX_UPGRADE_CHECK_INTERVAL ||
      interval % UPGRADE_CHECK_INTERVAL_STEP !== 0
    ) {
      throw new Error(
        "Upgrade check interval must be a 15-minute increment between 15 minutes and 168 hours"
      );
    }
    await this.saveSetting("upgradeCheckInterval", interval);
  }

  private async saveSetting(
    key: "autoUpgrade" | "upgradeCheckInterval",
    value: boolean | number
  ): Promise<void> {
    const update = this.saveQueue
      .catch(() => {})
      .then(() => this.writeSetting(key, value));
    this.saveQueue = update;
    await update;
  }

  private async writeSetting(
    key: "autoUpgrade" | "upgradeCheckInterval",
    value: boolean | number
  ): Promise<void> {
    let settings: ManagedSettings = {};
    try {
      settings = await readManagedSettings(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        settings = {};
      } else if (
        error instanceof ManagedSettingsError &&
        error.recoverable
      ) {
        this.reportError(`${error.message}; replacing it with a valid setting`);
        settings = {};
      } else {
        throw error;
      }
    }

    const directory = dirname(this.path);
    const temporaryPath = join(
      directory,
      `.${basename(this.path)}.${process.pid}.${randomUUID()}.tmp`
    );

    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify({ ...settings, [key]: value }, null, 2)}\n`,
        { mode: 0o600, flush: true }
      );
      await rename(temporaryPath, this.path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}
