/**
 * MQTT Publisher
 *
 * Handles MQTT communication with Home Assistant using the Auto Discovery protocol.
 * Manages device registration, entity publishing, and maintains MQTT connections
 * for all sensor data from the various status readers.
 */

import * as mqtt from "mqtt";
import * as winston from "winston";

export interface MqttConfig {
  broker: string;
  username?: string;
  password?: string;
  deviceId: string;
  deviceName: string;
  version: string;
}

export interface DeviceConfig {
  identifiers: string[];
  name: string;
  model: string;
  manufacturer: string;
  sw_version: string;
}

export interface EntityConfig {
  name: string;
  unique_id: string;
  state_topic: string;
  device_class?: string;
  unit_of_measurement?: string;
  value_template?: string;
  state_class?: string;
  icon?: string;
  entity_category?: string;
  enabled_by_default?: boolean;
  json_attributes_topic?: string;
  device: DeviceConfig;
}

export interface MqttCommandDefinition {
  id: string;
  name: string;
  icon?: string;
  execute: () => Promise<void>;
}

export interface MqttSwitchDefinition {
  id: string;
  name: string;
  icon?: string;
  getState: () => boolean;
  setState: (enabled: boolean) => Promise<void>;
}

interface MqttButtonConfig {
  name: string;
  unique_id: string;
  command_topic: string;
  payload_press: string;
  availability_topic: string;
  payload_available: string;
  payload_not_available: string;
  icon?: string;
  device: DeviceConfig;
}

interface MqttSwitchConfig {
  name: string;
  unique_id: string;
  state_topic: string;
  command_topic: string;
  payload_on: string;
  payload_off: string;
  state_on: string;
  state_off: string;
  availability_topic: string;
  payload_available: string;
  payload_not_available: string;
  optimistic: false;
  qos: 1;
  retain: false;
  entity_category: "config";
  icon?: string;
  device: DeviceConfig;
}

interface CommandResult {
  command: string;
  status: "success" | "error";
  timestamp: string;
  error?: string;
}

// Home Assistant MQTT Discovery topics
const DISCOVERY_PREFIX = "homeassistant";
const COMMAND_PREFIX = "hass-agent";

export class MqttDeviceFramework {
  private logger: winston.Logger;
  private config: MqttConfig;
  private client: mqtt.MqttClient;
  private deviceId: string;
  private deviceConfig: DeviceConfig;
  private commandTopic: string;
  private commandResultTopic: string;
  private commands = new Map<string, MqttCommandDefinition>();
  private switches = new Map<string, MqttSwitchDefinition>();
  private switchUpdates = new Map<string, Promise<void>>();
  private retiredCommandIds = new Set<string>();

  constructor(config: MqttConfig, logger: winston.Logger) {
    this.config = config;
    this.logger = logger;
    this.deviceId = this.config.deviceId;
    this.commandTopic = `${COMMAND_PREFIX}/${this.deviceId}/command`;
    this.commandResultTopic = `${COMMAND_PREFIX}/${this.deviceId}/command/result`;

    this.deviceConfig = {
      identifiers: [this.deviceId],
      name: this.config.deviceName,
      model: "macOS System Monitor",
      manufacturer: "Apple",
      sw_version: `${this.config.version} (macOS ${require("os").release()})`,
    };

    this.client = mqtt.connect(this.config.broker, {
      username: this.config.username,
      password: this.config.password,
      clientId: `hass-agent-${this.deviceId}`,
      forceNativeWebSocket: true,
      reconnectOnConnackError: true,
      reconnectPeriod: 5000,
      connectTimeout: 30000,
      clean: true,
      will: {
        topic: `${DISCOVERY_PREFIX}/status/${this.deviceId}`,
        payload: "offline",
        qos: 1,
        retain: true,
      },
    });

    this.setupMqttClient();
  }

  public createDeviceEmitter<TState>(
    topicId: string,
    entities: Array<{
      type: "sensor" | "binary_sensor";
      id: string;
      config: Omit<EntityConfig, "device" | "unique_id" | "state_topic">;
    }>
  ): MqttDeviceEmitter<TState> {
    return new MqttDeviceEmitter<TState>(
      this.client,
      this.deviceId,
      this.deviceConfig,
      topicId,
      entities,
      this.logger
    );
  }

  public registerCommands(commands: MqttCommandDefinition[]): void {
    for (const command of commands) {
      if (!/^[a-z0-9_]+$/.test(command.id)) {
        throw new Error(`Invalid MQTT command id: ${command.id}`);
      }
      if (this.commands.has(command.id)) {
        throw new Error(`Duplicate MQTT command id: ${command.id}`);
      }
      this.commands.set(command.id, command);
      this.retiredCommandIds.delete(command.id);
    }

    this.publishCommandDiscoveryConfigs();
    if (this.client.connected) {
      this.subscribeToCommandTopic();
    }
  }

  public retireCommands(commandIds: readonly string[]): void {
    for (const commandId of commandIds) {
      if (!/^[a-z0-9_]+$/.test(commandId)) {
        throw new Error(`Invalid MQTT command id: ${commandId}`);
      }
      this.commands.delete(commandId);
      this.retiredCommandIds.add(commandId);
    }

    this.publishRetiredCommandDiscoveryConfigs();
  }

  public registerSwitches(switches: MqttSwitchDefinition[]): void {
    for (const definition of switches) {
      if (!/^[a-z0-9_]+$/.test(definition.id)) {
        throw new Error(`Invalid MQTT switch id: ${definition.id}`);
      }
      if (this.switches.has(definition.id)) {
        throw new Error(`Duplicate MQTT switch id: ${definition.id}`);
      }
      this.switches.set(definition.id, definition);
    }

    this.publishSwitchDiscoveryConfigs();
    this.publishSwitchStates();
    if (this.client.connected) {
      this.subscribeToSwitchTopics();
    }
  }

  public async connect(): Promise<void> {
    return new Promise((resolve) => {
      if (this.client.connected) {
        // Publish online status
        this.client.publish(
          `${DISCOVERY_PREFIX}/status/${this.deviceId}`,
          "online",
          { qos: 1, retain: true }
        );
        this.subscribeToCommandTopic();
        this.subscribeToSwitchTopics();
        this.publishSwitchStates();
        resolve();
      } else {
        this.client.once("connect", () => {
          // Publish online status after connection
          this.client.publish(
            `${DISCOVERY_PREFIX}/status/${this.deviceId}`,
            "online",
            { qos: 1, retain: true }
          );
          resolve();
        });
      }
    });
  }

  public async disconnect(): Promise<void> {
    return new Promise((resolve) => {
      // Set a timeout to prevent hanging
      const timeout = setTimeout(() => {
        this.logger.warn("MQTT disconnect timeout, forcing close");
        resolve();
      }, 5000); // 5 second timeout

      // Disable auto-reconnect to prevent reconnection during shutdown
      if (this.client.options) {
        this.client.options.reconnectPeriod = 0;
      }

      // Publish offline status before disconnecting
      this.client.publish(
        `${DISCOVERY_PREFIX}/status/${this.deviceId}`,
        "offline",
        { qos: 1, retain: true },
        () => {
          this.client.end(true, {}, () => {
            clearTimeout(timeout);
            this.logger.info("MQTT client disconnected");
            resolve();
          });
        }
      );
    });
  }

  private setupMqttClient(): void {
    this.client.on("connect", () => {
      this.logger.info("Connected to MQTT broker");
      // Publish online status
      this.client.publish(
        `${DISCOVERY_PREFIX}/status/${this.deviceId}`,
        "online",
        { qos: 1, retain: true }
      );
      this.publishCommandDiscoveryConfigs();
      this.publishSwitchDiscoveryConfigs();
      this.publishSwitchStates();
      this.subscribeToCommandTopic();
      this.subscribeToSwitchTopics();
    });

    this.client.on("error", (error) => {
      this.logger.error(`MQTT connection error: ${error}`);
    });

    this.client.on("offline", () => {
      this.logger.warn("MQTT client offline");
    });

    this.client.on("reconnect", () => {
      this.logger.info("Reconnecting to MQTT broker...");
    });

    this.client.on("message", (topic, payload, packet) => {
      void this.handleMessage(topic, payload, packet);
    });
  }

  private publishCommandDiscoveryConfigs(): void {
    this.publishRetiredCommandDiscoveryConfigs();

    if (this.commands.size === 0) {
      return;
    }

    for (const command of this.commands.values()) {
      const config: MqttButtonConfig = {
        name: command.name,
        unique_id: `${this.deviceId}_${command.id}`,
        command_topic: this.commandTopic,
        payload_press: command.id,
        availability_topic: `${DISCOVERY_PREFIX}/status/${this.deviceId}`,
        payload_available: "online",
        payload_not_available: "offline",
        icon: command.icon,
        device: this.deviceConfig,
      };

      this.client.publish(
        `${DISCOVERY_PREFIX}/button/${this.deviceId}/${command.id}/config`,
        JSON.stringify(config),
        { qos: 1, retain: true }
      );
    }

    const resultConfig: EntityConfig = {
      name: "Last Command",
      unique_id: `${this.deviceId}_last_command`,
      state_topic: this.commandResultTopic,
      value_template: "{{ value_json.command }}",
      json_attributes_topic: this.commandResultTopic,
      icon: "mdi:console",
      entity_category: "diagnostic",
      enabled_by_default: true,
      device: this.deviceConfig,
    };

    this.client.publish(
      `${DISCOVERY_PREFIX}/sensor/${this.deviceId}/last_command/config`,
      JSON.stringify({
        ...resultConfig,
        availability_topic: `${DISCOVERY_PREFIX}/status/${this.deviceId}`,
        payload_available: "online",
        payload_not_available: "offline",
      }),
      { qos: 1, retain: true }
    );
  }

  private publishRetiredCommandDiscoveryConfigs(): void {
    for (const commandId of this.retiredCommandIds) {
      this.client.publish(
        `${DISCOVERY_PREFIX}/button/${this.deviceId}/${commandId}/config`,
        "",
        { qos: 1, retain: true }
      );
    }
  }

  private publishSwitchDiscoveryConfigs(): void {
    for (const definition of this.switches.values()) {
      const config: MqttSwitchConfig = {
        name: definition.name,
        unique_id: `${this.deviceId}_${definition.id}`,
        state_topic: this.getSwitchStateTopic(definition.id),
        command_topic: this.getSwitchCommandTopic(definition.id),
        payload_on: "ON",
        payload_off: "OFF",
        state_on: "ON",
        state_off: "OFF",
        availability_topic: `${DISCOVERY_PREFIX}/status/${this.deviceId}`,
        payload_available: "online",
        payload_not_available: "offline",
        optimistic: false,
        qos: 1,
        retain: false,
        entity_category: "config",
        icon: definition.icon,
        device: this.deviceConfig,
      };

      this.client.publish(
        `${DISCOVERY_PREFIX}/switch/${this.deviceId}/${definition.id}/config`,
        JSON.stringify(config),
        { qos: 1, retain: true }
      );
    }
  }

  private publishSwitchStates(): void {
    for (const definition of this.switches.values()) {
      this.publishSwitchState(definition);
    }
  }

  private publishSwitchState(definition: MqttSwitchDefinition): void {
    this.client.publish(
      this.getSwitchStateTopic(definition.id),
      definition.getState() ? "ON" : "OFF",
      { qos: 1, retain: true }
    );
  }

  private subscribeToCommandTopic(): void {
    if (!this.client.connected || this.commands.size === 0) {
      return;
    }

    this.client.subscribe(this.commandTopic, { qos: 1 }, (error) => {
      if (error) {
        this.logger.error(
          `Failed to subscribe to MQTT command topic ${this.commandTopic}: ${error}`
        );
        return;
      }

      this.logger.info(
        `Listening for ${this.commands.size} allowlisted command(s) on ${this.commandTopic}`
      );
    });
  }

  private subscribeToSwitchTopics(): void {
    if (!this.client.connected) {
      return;
    }

    for (const definition of this.switches.values()) {
      const topic = this.getSwitchCommandTopic(definition.id);
      this.client.subscribe(topic, { qos: 1 }, (error) => {
        if (error) {
          this.logger.error(
            `Failed to subscribe to MQTT switch topic ${topic}: ${error}`
          );
        }
      });
    }
  }

  private getSwitchStateTopic(switchId: string): string {
    return `${COMMAND_PREFIX}/${this.deviceId}/switch/${switchId}/state`;
  }

  private getSwitchCommandTopic(switchId: string): string {
    return `${COMMAND_PREFIX}/${this.deviceId}/switch/${switchId}/set`;
  }

  private async handleMessage(
    topic: string,
    payload: Buffer,
    packet?: { retain?: boolean }
  ): Promise<void> {
    if (topic === this.commandTopic) {
      if (packet?.retain) {
        this.logger.warn(`Ignored retained MQTT command on ${topic}`);
        return;
      }
      await this.handleCommandMessage(payload);
      return;
    }

    const definition = [...this.switches.values()].find(
      (candidate) => this.getSwitchCommandTopic(candidate.id) === topic
    );
    if (!definition) {
      return;
    }

    if (packet?.retain) {
      this.logger.warn(
        `Ignored retained MQTT switch command for ${definition.id}`
      );
      this.publishSwitchState(definition);
      return;
    }

    const requestedState = payload.toString("utf8");
    if (requestedState !== "ON" && requestedState !== "OFF") {
      this.logger.warn(
        `Ignored invalid MQTT switch payload for ${definition.id}: ${requestedState}`
      );
      this.publishSwitchState(definition);
      return;
    }

    const previousUpdate = this.switchUpdates.get(definition.id);
    const update = (previousUpdate ?? Promise.resolve()).then(async () => {
      try {
        await definition.setState(requestedState === "ON");
        this.logger.info(
          `MQTT switch updated: ${definition.id}=${requestedState}`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `MQTT switch update failed (${definition.id}): ${message}`
        );
      } finally {
        this.publishSwitchState(definition);
      }
    });
    this.switchUpdates.set(definition.id, update);

    try {
      await update;
    } finally {
      if (this.switchUpdates.get(definition.id) === update) {
        this.switchUpdates.delete(definition.id);
      }
    }
  }

  private async handleCommandMessage(
    payload: Buffer
  ): Promise<void> {
    const commandId = payload.toString("utf8").trim();
    const command = this.commands.get(commandId);
    if (!command) {
      this.logger.warn(`Ignored unknown MQTT command: ${commandId}`);
      return;
    }

    this.logger.info(`Executing MQTT command: ${commandId}`);

    try {
      await command.execute();
      this.publishCommandResult({
        command: commandId,
        status: "success",
        timestamp: new Date().toISOString(),
      });
      this.logger.info(`MQTT command completed: ${commandId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.publishCommandResult({
        command: commandId,
        status: "error",
        timestamp: new Date().toISOString(),
        error: message,
      });
      this.logger.error(`MQTT command failed (${commandId}): ${message}`);
    }
  }

  private publishCommandResult(result: CommandResult): void {
    this.client.publish(this.commandResultTopic, JSON.stringify(result), {
      qos: 1,
      retain: true,
    });
  }
}

export class MqttDeviceEmitter<TState> {
  private client: mqtt.MqttClient;
  private deviceId: string;
  private deviceConfig: DeviceConfig;
  private topicId: string;
  private entities: Array<{
    type: "sensor" | "binary_sensor";
    id: string;
    config: Omit<EntityConfig, "device" | "unique_id" | "state_topic">;
  }>;
  private logger: winston.Logger;
  private stateTopic: string;

  constructor(
    client: mqtt.MqttClient,
    deviceId: string,
    deviceConfig: DeviceConfig,
    topicId: string,
    entities: Array<{
      type: "sensor" | "binary_sensor";
      id: string;
      config: Omit<EntityConfig, "device" | "unique_id" | "state_topic">;
    }>,
    logger: winston.Logger
  ) {
    this.client = client;
    this.deviceId = deviceId;
    this.deviceConfig = deviceConfig;
    this.topicId = topicId;
    this.entities = entities;
    this.logger = logger;
    this.stateTopic = `${DISCOVERY_PREFIX}/sensor/${this.deviceId}/${this.topicId}/state`;

    // Publish discovery configurations for all entities
    this.publishDiscoveryConfigs();
  }

  public publishState(
    data: TState,
    options: mqtt.IClientPublishOptions = { qos: 1, retain: true }
  ): void {
    this.client.publish(this.stateTopic, JSON.stringify(data), options);
  }

  private publishDiscoveryConfigs(): void {
    for (const entity of this.entities) {
      const config: EntityConfig = {
        ...entity.config,
        unique_id: `${this.deviceId}_${entity.id}`,
        state_topic: this.stateTopic,
        device: this.deviceConfig,
      };

      this.client.publish(
        `${DISCOVERY_PREFIX}/${entity.type}/${this.deviceId}/${entity.id}/config`,
        JSON.stringify(config),
        { retain: true }
      );
    }
  }
}
