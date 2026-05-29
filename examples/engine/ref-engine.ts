#!/usr/bin/env bun

import {
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const heartbeatPath =
  process.env.MCPLAYER_REF_ENGINE_HEARTBEAT ?? process.argv[2];
if (!heartbeatPath) {
  throw new Error(
    "MCPLAYER_REF_ENGINE_HEARTBEAT or a heartbeat path argument is required",
  );
}

const intervalMs = optionalPositiveNumber(
  process.env.MCPLAYER_REF_ENGINE_HEARTBEAT_INTERVAL_MS,
) ?? 250;

mkdirSync(dirname(heartbeatPath), { recursive: true });

let sequence = 0;
const writeHeartbeat = () => {
  sequence += 1;
  const now = Date.now();
  const tmpPath = `${heartbeatPath}.${process.pid}.${sequence}.tmp`;
  writeFileSync(
    tmpPath,
    JSON.stringify({
      engine: "ref",
      pid: process.pid,
      sequence,
      timestamp_ms: now,
    }),
  );
  renameSync(tmpPath, heartbeatPath);
};

writeHeartbeat();
console.log(
  `REF_ENGINE_READY engine=ref pid=${process.pid} heartbeat=${heartbeatPath} interval_ms=${intervalMs}`,
);

const timer = setInterval(writeHeartbeat, intervalMs);

const shutdown = () => {
  clearInterval(timer);
  rmSync(heartbeatPath, { force: true });
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await new Promise(() => {});

function optionalPositiveNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`expected positive numeric env value, got: ${value}`);
  }
  return parsed;
}
