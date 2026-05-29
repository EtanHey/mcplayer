#!/usr/bin/env bun

import { McplayerServer } from ".";
import {
  EngineSupervisor,
  createHeartbeatFileHealthProbe,
} from "./engine";

const server = new McplayerServer({
  engine: createEnvEngineSupervisor(),
  maxBytesPerChannel: optionalNumber(process.env.MCPLAYER_WAL_MAX_BYTES_PER_CHANNEL),
  maxRecordsPerChannel: optionalNumber(
    process.env.MCPLAYER_WAL_MAX_RECORDS_PER_CHANNEL,
  ),
});

await server.start();

console.log(
  `MCPLAYER_SERVER_LISTENING socket=${server.socketPath} MCPLAYER_SOCKET=${process.env.MCPLAYER_SOCKET ?? ""} wal=${server.walPath}`,
);

let shuttingDown: Promise<void> | undefined;
const shutdown = async () => {
  if (!shuttingDown) shuttingDown = server.shutdown();
  try {
    await shuttingDown;
    process.exit(0);
  } catch (error) {
    console.error("mcplayer-server shutdown failed", error);
    process.exit(1);
  }
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await new Promise(() => {});

function optionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`expected numeric env value, got: ${value}`);
  }
  return parsed;
}

function createEnvEngineSupervisor(): EngineSupervisor | undefined {
  const heartbeatPath = process.env.MCPLAYER_ENGINE_HEARTBEAT_FILE;
  if (!heartbeatPath) return undefined;

  return new EngineSupervisor({
    initialState: "building",
    probeIntervalMs:
      optionalNumber(process.env.MCPLAYER_ENGINE_PROBE_INTERVAL_MS) ?? 250,
    healthProbe: createHeartbeatFileHealthProbe({
      path: heartbeatPath,
      staleMs:
        optionalNumber(process.env.MCPLAYER_ENGINE_HEARTBEAT_STALE_MS) ?? 1000,
    }),
  });
}
