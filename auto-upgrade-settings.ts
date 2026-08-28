import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface AutoUpgradeSettingsStore {
  load(fallback: boolean): Promise<boolean>;
  save(enabled: boolean): Promise<void>;
}

interface ManagedSettings {
  autoUpgrade?: boolean;
  [key: string]: unknown;
}

const MAX_SETTINGS_BYTES = 64 * 1024;

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
        `${JSON.stringify({ ...settings, autoUpgrade: enabled }, null, 2)}\n`,
        { mode: 0o600, flush: true }
      );
      await rename(temporaryPath, this.path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}
