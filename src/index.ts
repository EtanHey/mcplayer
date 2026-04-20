#!/usr/bin/env bun

import { loadConfig } from "./config";
import { McplayerLogger } from "./logger";
import { McplayerBroker } from "./broker";

const config = loadConfig();
const logger = new McplayerLogger(config);
const broker = new McplayerBroker(config, logger);

try {
  await broker.start();
} catch (error) {
  logger.error("daemon-start-failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  throw error;
}

const shutdown = async (signal: string) => {
  await broker.shutdown(signal);
};

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
