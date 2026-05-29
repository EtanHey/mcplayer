import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const heartbeatPath = process.env.MCPLAYER_MOCK_ENGINE_HEARTBEAT;
if (!heartbeatPath) {
  throw new Error("MCPLAYER_MOCK_ENGINE_HEARTBEAT is required");
}

mkdirSync(dirname(heartbeatPath), { recursive: true });

const writeHeartbeat = () => {
  writeFileSync(heartbeatPath, `${process.pid}:${Date.now()}`);
};

writeHeartbeat();
console.log(`MOCK_ENGINE_READY pid=${process.pid} heartbeat=${heartbeatPath}`);

setInterval(writeHeartbeat, 25);

await new Promise(() => {});
