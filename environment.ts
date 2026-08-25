import { loadEnvFile } from "node:process";

/**
 * Load the agent's dotenv configuration without overriding variables supplied
 * by launchd or the invoking process. Missing files are allowed because some
 * installations configure the agent entirely through environment variables.
 */
export function loadEnvironmentFile(path = ".env"): void {
  try {
    loadEnvFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}
