import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnvironmentFile } from "./environment.ts";

const originalDeviceId = process.env.DEVICE_ID;
const originalMqttBroker = process.env.MQTT_BROKER;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  if (originalDeviceId === undefined) {
    delete process.env.DEVICE_ID;
  } else {
    process.env.DEVICE_ID = originalDeviceId;
  }

  if (originalMqttBroker === undefined) {
    delete process.env.MQTT_BROKER;
  } else {
    process.env.MQTT_BROKER = originalMqttBroker;
  }

  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      })
    )
  );
});

async function createEnvironmentFile(contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hass-agent-env-"));
  temporaryDirectories.push(directory);
  const path = join(directory, ".env");
  await writeFile(path, contents);
  return path;
}

describe.sequential("loadEnvironmentFile", () => {
  it("loads the existing dotenv configuration", async () => {
    delete process.env.DEVICE_ID;
    delete process.env.MQTT_BROKER;
    const path = await createEnvironmentFile(
      "DEVICE_ID=existing-device\nMQTT_BROKER=mqtt://homeassistant.local:1883\n"
    );

    loadEnvironmentFile(path);

    expect(process.env.DEVICE_ID).toBe("existing-device");
    expect(process.env.MQTT_BROKER).toBe("mqtt://homeassistant.local:1883");
  });

  it("preserves variables supplied by the invoking process", async () => {
    process.env.DEVICE_ID = "launchd-device";
    const path = await createEnvironmentFile("DEVICE_ID=dotenv-device\n");

    loadEnvironmentFile(path);

    expect(process.env.DEVICE_ID).toBe("launchd-device");
  });

  it("allows installations without a dotenv file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hass-agent-env-"));
    temporaryDirectories.push(directory);

    expect(() => loadEnvironmentFile(join(directory, ".env"))).not.toThrow();
  });
});
