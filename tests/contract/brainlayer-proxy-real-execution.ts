// FUNCTIONAL real-execution proof for the BrainLayer reverse-proxy (P0.3).
//
// Proves reconnect-survival against the REAL BrainBar (/tmp/brainbar.sock) WITHOUT
// killing the live BrainBarD (hard rule #4 — that would drop every running
// agent). Instead a disposable `socat` bridge backed by the real BrainBar stands
// in as the killable upstream; we kill+restart the BRIDGE (never BrainBarD) and
// show the agent's front connection survives and real BrainBar responses resume.
//
//   agent client ──▶ BrainlayerProxy front ──▶ socat bridge (killable) ──▶ real BrainBar
//
// Required success marker:
//   PROXY_RECONNECT_SURVIVED front_stable=1 reconnected=1 brainbar=real
//   BRAINLAYER_DEGRADED_LOUD signalled=1 recovered=1 silent=0

import net from "node:net";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeLine, NdjsonDecoder } from "../../src/protocol";
import { BrainlayerProxy } from "../../src/brainlayer-proxy";

const BRAINBAR = "/tmp/brainbar.sock";
const root = mkdtempSync(join(tmpdir(), "blp-real-"));
const bridgePath = join(root, "bridge.sock");
const frontPath = join(root, "front.sock");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(m);
}

type Bridge = ReturnType<typeof Bun.spawn>;

// A single-connection socat bridge: front-end UNIX-LISTEN backed by the real
// BrainBar socket. Killing it severs the proxy's upstream (= a BrainBar restart
// from the proxy's point of view); BrainBarD itself is never touched.
async function startBridge(): Promise<Bridge> {
  if (existsSync(bridgePath)) rmSync(bridgePath, { force: true });
  const proc = Bun.spawn({
    cmd: [
      "socat",
      `UNIX-LISTEN:${bridgePath},reuseaddr`,
      `UNIX-CONNECT:${BRAINBAR}`,
    ],
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 100 && !existsSync(bridgePath); i++) await sleep(20);
  assert(existsSync(bridgePath), "bridge socket never appeared");
  return proc;
}

async function killBridge(proc: Bridge): Promise<void> {
  proc.kill("SIGKILL");
  await proc.exited;
  if (existsSync(bridgePath)) rmSync(bridgePath, { force: true });
}

function connectClient(socketPath: string) {
  const sock = net.createConnection(socketPath);
  const decoder = new NdjsonDecoder();
  const inbox: Array<Record<string, unknown>> = [];
  let dropped = false;
  sock.on("close", () => (dropped = true));
  sock.on("data", (chunk) => {
    for (const m of decoder.push(chunk) as Array<Record<string, unknown>>) {
      inbox.push(m);
    }
  });
  const waitForId = async (id: number, timeoutMs: number) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const index = inbox.findIndex((m) => m.id === id);
      if (index !== -1) return inbox.splice(index, 1)[0];
      await sleep(20);
    }
    throw new Error(`timeout waiting for response id=${id}`);
  };
  return {
    everDropped: () => dropped,
    ready: new Promise<void>((res, rej) => {
      sock.once("connect", res);
      sock.once("error", rej);
    }),
    request(
      id: number,
      method: string,
      params: Record<string, unknown>,
      timeoutMs = 3000,
    ) {
      sock.write(encodeLine({ jsonrpc: "2.0", id, method, params }));
      return waitForId(id, timeoutMs);
    },
    initialize(id: number, timeoutMs = 3000) {
      sock.write(
        encodeLine({
          jsonrpc: "2.0",
          id,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "blp-real-exec", version: "0" },
          },
        }),
      );
      return waitForId(id, timeoutMs);
    },
    close: () => sock.destroy(),
  };
}

function serverName(res: Record<string, unknown>): string | undefined {
  return (res.result as { serverInfo?: { name?: string } } | undefined)
    ?.serverInfo?.name;
}

let bridge: Bridge | undefined;
try {
  assert(existsSync(BRAINBAR), `real BrainBar not present at ${BRAINBAR}`);

  bridge = await startBridge();
  const proxy = new BrainlayerProxy({
    frontSocketPath: frontPath,
    upstream: { kind: "unix", path: bridgePath },
    reconnectDelayMs: 50,
    maxReconnectDelayMs: 500,
    degradedMs: 250,
    requestTimeoutMs: 5000,
  });
  await proxy.start();

  const client = connectClient(frontPath);
  await client.ready;
  console.log(`CLIENT_CONNECTED front=${frontPath}`);

  // BEFORE: a real initialize through the proxy hits the real BrainBar.
  const before = await client.initialize(1);
  assert(
    serverName(before) === "brainbar",
    "before-kill not from real brainbar",
  );
  console.log(
    `BEFORE_KILL serverInfo.name=${serverName(before)} (real brainbar)`,
  );

  // KILL the bridge — the proxy's upstream drops. BrainBarD is untouched.
  await killBridge(bridge);
  bridge = undefined;
  console.log("BRIDGE_KILLED upstream_severed=1 brainbard_untouched=1");
  await sleep(100);
  assert(!client.everDropped(), "front connection dropped when upstream died");
  console.log("FRONT_SURVIVED_KILL front_stable=1");

  const degraded = await client.request(2, "brain_search", {}, 6000);
  const degradedMessage = String(
    (degraded.error as { message?: unknown } | undefined)?.message ?? "",
  );
  assert(
    degraded.error && degradedMessage.includes("BrainLayer degraded"),
    `missing LOUD degraded error: ${JSON.stringify(degraded)}`,
  );
  assert(
    degradedMessage.includes("unreachable"),
    `degraded error did not say unreachable: ${degradedMessage}`,
  );
  console.log(`DEGRADED_ERROR id=2 message=${degradedMessage}`);

  // RESTART the bridge — BrainBar reachable again; proxy reconnects.
  bridge = await startBridge();
  console.log("BRIDGE_RESTARTED");
  await sleep(700);

  // AFTER: the SAME client (never reconnected) initializes again — proxy must
  // have reconnected the upstream once, real BrainBar answers.
  let after: Record<string, unknown> | undefined;
  let nextId = 3;
  for (let i = 0; i < 40 && !after; i++) {
    try {
      const candidate = await client.initialize(nextId++, 500);
      if (serverName(candidate) === "brainbar") after = candidate;
    } catch {
      await sleep(50);
    }
  }
  assert(
    after && serverName(after) === "brainbar",
    "after-restart not from real brainbar",
  );
  assert(!client.everDropped(), "front connection dropped across the restart");
  console.log(
    `AFTER_RESTART serverInfo.name=${serverName(after)} (real brainbar, same client)`,
  );

  console.log("BRAINLAYER_DEGRADED_LOUD signalled=1 recovered=1 silent=0");
  console.log(
    "PROXY_RECONNECT_SURVIVED front_stable=1 reconnected=1 brainbar=real",
  );

  client.close();
  await proxy.shutdown();
} finally {
  if (bridge) await killBridge(bridge).catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
