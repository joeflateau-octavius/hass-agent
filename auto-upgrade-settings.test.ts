import {
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import {
  FileAutoUpgradeSettingsStore,
  MAX_UPGRADE_CHECK_INTERVAL,
  MIN_UPGRADE_CHECK_INTERVAL,
} from "./auto-upgrade-settings.ts";

const temporaryDirectories: string[] = [];

async function createStore(): Promise<{
  path: string;
  store: FileAutoUpgradeSettingsStore;
}> {
  const directory = await mkdtemp(join(tmpdir(), "hass-agent-settings-"));
  temporaryDirectories.push(directory);
  const path = join(directory, ".settings.json");
  return { path, store: new FileAutoUpgradeSettingsStore(path) };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("FileAutoUpgradeSettingsStore", () => {
  it("uses the environment-derived fallback before HA manages the setting", async () => {
    const { store } = await createStore();

    await expect(store.load(true)).resolves.toBe(true);
    await expect(store.load(false)).resolves.toBe(false);
  });

  it("persists and loads the HA-managed value", async () => {
    const { store } = await createStore();

    await store.save(true);

    await expect(store.load(false)).resolves.toBe(true);
  });

  it("lets a managed false value override an enabled environment fallback", async () => {
    const { store } = await createStore();

    await store.save(false);

    await expect(store.load(true)).resolves.toBe(false);
  });

  it("uses the environment-derived interval before HA manages it", async () => {
    const { store } = await createStore();

    await expect(store.loadInterval(3 * 60 * 60 * 1000)).resolves.toBe(
      3 * 60 * 60 * 1000
    );
  });

  it("persists an HA-managed interval and preserves the upgrade switch", async () => {
    const { path, store } = await createStore();
    await store.save(true);

    await store.saveInterval(90 * 60 * 1000);

    await expect(store.loadInterval(3 * 60 * 60 * 1000)).resolves.toBe(
      90 * 60 * 1000
    );
    await expect(store.load(false)).resolves.toBe(true);
    await expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      autoUpgrade: true,
      upgradeCheckInterval: 90 * 60 * 1000,
    });
  });

  it("serializes simultaneous switch and interval writes", async () => {
    const { path, store } = await createStore();

    await Promise.all([
      store.save(true),
      store.saveInterval(90 * 60 * 1000),
    ]);

    await expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      autoUpgrade: true,
      upgradeCheckInterval: 90 * 60 * 1000,
    });
  });

  it("rejects managed intervals outside the supported range or step", async () => {
    const { store } = await createStore();

    await expect(
      store.saveInterval(MIN_UPGRADE_CHECK_INTERVAL - 1)
    ).rejects.toThrow("15-minute increment");
    await expect(
      store.saveInterval(MAX_UPGRADE_CHECK_INTERVAL + 1)
    ).rejects.toThrow("15-minute increment");
    await expect(store.saveInterval(20 * 60 * 1000)).rejects.toThrow(
      "15-minute increment"
    );
  });

  it("falls back to the environment interval when the managed value is invalid", async () => {
    const { path } = await createStore();
    const reportError = vi.fn();
    const store = new FileAutoUpgradeSettingsStore(path, reportError);
    await writeFile(path, '{"upgradeCheckInterval":1000}\n');

    await expect(store.loadInterval(3 * 60 * 60 * 1000)).resolves.toBe(
      3 * 60 * 60 * 1000
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.stringContaining("environment-derived upgrade interval")
    );
  });

  it("preserves future managed settings when changing auto-upgrade", async () => {
    const { path, store } = await createStore();
    await writeFile(path, '{"futureSetting":"kept","autoUpgrade":false}\n');

    await store.save(true);

    await expect(
      JSON.parse(await readFile(path, "utf8"))
    ).toEqual({ futureSetting: "kept", autoUpgrade: true });
  });

  it("writes the managed settings file with user-only permissions", async () => {
    const { path, store } = await createStore();

    await store.save(false);

    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("fails closed and lets an explicit HA change repair malformed settings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hass-agent-settings-"));
    temporaryDirectories.push(directory);
    const path = join(directory, ".settings.json");
    const reportError = vi.fn();
    const store = new FileAutoUpgradeSettingsStore(path, reportError);
    await writeFile(path, '{"autoUpgrade":"yes"}\n');

    await expect(store.load(true)).resolves.toBe(false);
    await store.save(true);

    await expect(store.load(false)).resolves.toBe(true);
    expect(reportError).toHaveBeenCalledWith(
      expect.stringContaining("automatic upgrades are disabled")
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.stringContaining("replacing it with a valid setting")
    );
  });

  it("fails closed without following a settings symlink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hass-agent-settings-"));
    temporaryDirectories.push(directory);
    const target = join(directory, "target.json");
    const path = join(directory, ".settings.json");
    const reportError = vi.fn();
    const store = new FileAutoUpgradeSettingsStore(path, reportError);
    await writeFile(target, '{"autoUpgrade":true}\n');
    await symlink(target, path);

    await expect(store.load(true)).resolves.toBe(false);
    await expect(store.save(true)).rejects.toThrow("must be a regular file");
    expect(await readFile(target, "utf8")).toBe('{"autoUpgrade":true}\n');
  });

  it("fails closed on an oversized settings file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hass-agent-settings-"));
    temporaryDirectories.push(directory);
    const path = join(directory, ".settings.json");
    const reportError = vi.fn();
    const store = new FileAutoUpgradeSettingsStore(path, reportError);
    await writeFile(path, "x".repeat(64 * 1024 + 1));

    await expect(store.load(true)).resolves.toBe(false);
    expect(reportError).toHaveBeenCalledWith(
      expect.stringContaining("exceeds 65536 bytes")
    );
  });
});
