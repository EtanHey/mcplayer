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

let shutdownPromise: Promise<void> | undefined;

const shutdown = (signal: string): Promise<void> => {
  if (!shutdownPromise) {
    shutdownPromise = broker
      .shutdown(signal)
      .then(() => {
        process.exit(0);
      })
      .catch((error) => {
        logger.error("daemon-shutdown-failed", {
          signal,
          error: error instanceof Error ? error.message : String(error),
        });
        process.exit(1);
      });
  }
  return shutdownPromise;
};

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
