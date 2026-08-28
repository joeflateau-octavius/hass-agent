/**
 * Auto-Updater Service
 *
 * Manages automatic updates for the Home Assistant Agent.
 * Checks for new versions periodically and executes update scripts
 * when newer versions are available.
 */

import * as winston from "winston";
import { executeCommand } from "./command-utils.ts";

export interface AutoUpdaterConfig {
  autoUpgrade: boolean;
  upgradeCheckInterval: number;
  installScriptUrl: string;
  version: string;
}

export class AutoUpdater {
  private config: AutoUpdaterConfig;
  private logger: winston.Logger;
  private upgradeCheckTimer?: NodeJS.Timeout;
  private upgradeCheckInFlight = false;

  constructor(config: AutoUpdaterConfig, logger: winston.Logger) {
    this.config = config;
    this.logger = logger;
  }

  public start(): void {
    if (
      !this.config.autoUpgrade ||
      this.config.version === "development" ||
      this.upgradeCheckTimer
    ) {
      return;
    }

    this.scheduleUpgradeCheck();
  }

  public stop(): void {
    if (this.upgradeCheckTimer) {
      clearInterval(this.upgradeCheckTimer);
      this.upgradeCheckTimer = undefined;
    }
  }

  public isEnabled(): boolean {
    return this.config.autoUpgrade;
  }

  public setEnabled(enabled: boolean): void {
    if (this.config.autoUpgrade === enabled) {
      return;
    }

    this.config.autoUpgrade = enabled;
    if (enabled) {
      this.start();
    } else {
      this.stop();
    }
  }

  public getCheckInterval(): number {
    return this.config.upgradeCheckInterval;
  }

  public setCheckInterval(interval: number): void {
    if (this.config.upgradeCheckInterval === interval) {
      return;
    }

    this.config.upgradeCheckInterval = interval;
    if (this.upgradeCheckTimer) {
      clearInterval(this.upgradeCheckTimer);
      this.upgradeCheckTimer = undefined;
      this.schedulePeriodicChecks();
    }
  }

  private scheduleUpgradeCheck(): void {
    void this.runUpgradeCheck();
    this.schedulePeriodicChecks();
  }

  private schedulePeriodicChecks(): void {
    this.upgradeCheckTimer = setInterval(() => {
      void this.runUpgradeCheck();
    }, this.config.upgradeCheckInterval);

    this.logger.info(
      `Auto-upgrade enabled, checking every ${
        this.config.upgradeCheckInterval / (60 * 60 * 1000)
      } hours`
    );
  }

  private async runUpgradeCheck(): Promise<void> {
    if (this.upgradeCheckInFlight) {
      this.logger.warn("Skipping upgrade check because one is already running");
      return;
    }

    this.upgradeCheckInFlight = true;
    try {
      this.logger.info("Checking for updates...");

      // Execute the install script with detached process so it can outlive this process
      // The install script may need to kill this process to update the binary
      await executeCommand(
        `curl -fsSL "${this.config.installScriptUrl}" | bash`,
        {
          env: { ...process.env, INSTALLED_VERSION: this.config.version },
          detached: true, // Allow the process to run independently
          stdio: "ignore", // Disconnect stdio so child can outlive parent
        }
      );
    } catch (error) {
      this.logger.error(`Upgrade check failed: ${error}`);
    } finally {
      this.upgradeCheckInFlight = false;
    }
  }
}
