// Real-execution proof for the always-on bus LaunchAgent (item 1).
//
// Unlike the engine-reset / first-engine proofs (which restart the server
// process MANUALLY), this drives REAL launchd: it bootstraps an isolated
// LaunchAgent (distinct label + temp socket/WAL/heartbeat — it never touches
// the canonical com.mcplayer.bus, com.mcplayer.multiplexer, /tmp/mcplayer-bus.sock,
// or BrainBar) and proves:
//   1. KeepAlive{SuccessfulExit:false} respawns the bus after `kill -9`.
//   2. The durable WAL survives a full daemon crash+respawn (a new process
//      replays an unacked message to a freshly reconnected client).
//   3. Content-aware heartbeat busy-state: status flips up -> busy -> up live.
//
// Required success marker:
//   DAEMON_ALWAYS_ON_OK keepalive_restart=1 wal_replay=1 busy_state=1 socket=stable

import {
  existsSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { encodeLine, NdjsonDecoder } from "../../src/protocol";

type JsonRpcMessage = Record<string, unknown>;

const uid = process.getuid?.() ?? 0;
const domain = `gui/${uid}`;
const label = `com.mcplayer.bus.proof.${process.pid}`;
const root = mkdtempSync(join(tmpdir(), "mcplayer-daemon-proof-"));
const socketPath = join(root, "bus.sock");
const walPath = join(root, "queue.wal");
const heartbeatPath = join(root, "engine.heartbeat");
const plistPath = join(root, `${label}.plist`);
const repoRoot = process.cwd();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function launchctl(
  ...args: string[]
): Promise<{ code: number; out: string }> {
  const child = Bun.spawn({
    cmd: ["launchctl", ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(child.stdout).text();
  const code = await child.exited;
  return { code, out };
}

// Keep the heartbeat "fresh" by writing the token AND stamping mtime to now.
function writeHeartbeat(token: string): void {
  writeFileSync(heartbeatPath, token);
  const now = new Date();
  utimesSync(heartbeatPath, now, now);
}

async function daemonPid(): Promise<number> {
  const { out } = await launchctl("list", label);
  const match = out.match(/"PID"\s*=\s*(\d+)/);
  return match ? Number(match[1]) : 0;
}

async function waitForPid(
  predicate: (pid: number) => boolean,
  label: string,
): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    const pid = await daemonPid();
    if (predicate(pid)) return pid;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForSocket(): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    if (existsSync(socketPath)) return;
    await sleep(100);
  }
  throw new Error("timed out waiting for socket to appear");
}

async function connectClient() {
  const socket = net.createConnection(socketPath);
  const decoder = new NdjsonDecoder();
  const inbox: JsonRpcMessage[] = [];
  const waiters: Array<(m: JsonRpcMessage) => void> = [];
  const pending = new Map<string, (m: JsonRpcMessage) => void>();
  let nextId = 1;
  let closed = false;

  socket.on("close", () => (closed = true));
  socket.on("error", () => (closed = true));
  socket.on("data", (chunk) => {
    for (const message of decoder.push(chunk) as JsonRpcMessage[]) {
      const id = message.id;
      if (
        (typeof id === "string" || typeof id === "number" || id === null) &&
        pending.has(String(id))
      ) {
        pending.get(String(id))!(message);
        pending.delete(String(id));
        continue;
      }
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else inbox.push(message);
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve();
    });
  });

  return {
    request: async (method: string, params: Record<string, unknown>) => {
      const id = nextId++;
      const response = new Promise<JsonRpcMessage>((resolve) =>
        pending.set(String(id), resolve),
      );
      socket.write(encodeLine({ jsonrpc: "2.0", id, method, params }));
      return await Promise.race([
        response,
        sleep(2000).then(() => {
          throw new Error(`timed out waiting for ${method}`);
        }),
      ]);
    },
    next: async (timeoutMs = 2000) => {
      const existing = inbox.shift();
      if (existing) return existing;
      let resolveWaiter: (m: JsonRpcMessage) => void = () => {};
      const notification = new Promise<JsonRpcMessage>((resolve) => {
        resolveWaiter = resolve;
        waiters.push(resolve);
      });
      return await Promise.race([
        notification,
        sleep(timeoutMs).then(() => {
          const i = waiters.indexOf(resolveWaiter);
          if (i !== -1) waiters.splice(i, 1);
          throw new Error("timed out waiting for notification");
        }),
      ]);
    },
    close: () => socket.end(),
    isClosed: () => closed || socket.destroyed,
  };
}

async function waitForStatus(
  client: Awaited<ReturnType<typeof connectClient>>,
  wanted: Set<string>,
): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    const status = await client.request("mcplayer.status", {});
    const state = (status.result as { state?: string }).state;
    if (state && wanted.has(state)) return state;
    await sleep(40);
  }
  throw new Error(`timed out waiting for status ${[...wanted].join("/")}`);
}

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${join(repoRoot, "bin/mcplayer-server")}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>1</integer>
  <key>StandardOutPath</key><string>${join(root, "bus.log")}</string>
  <key>StandardErrorPath</key><string>${join(root, "bus.err")}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${process.env.PATH ?? ""}</string>
    <key>MCPLAYER_SOCKET</key><string>${socketPath}</string>
    <key>MCPLAYER_WAL</key><string>${walPath}</string>
    <key>MCPLAYER_ENGINE_HEARTBEAT_FILE</key><string>${heartbeatPath}</string>
    <key>MCPLAYER_ENGINE_HEARTBEAT_STALE_MS</key><string>60000</string>
    <key>MCPLAYER_ENGINE_PROBE_INTERVAL_MS</key><string>40</string>
  </dict>
</dict>
</plist>
`;

try {
  writeHeartbeat("up");
  writeFileSync(plistPath, plist);

  await launchctl("bootout", `${domain}/${label}`); // best-effort clear stale
  const boot = await launchctl("bootstrap", domain, plistPath);
  assert(boot.code === 0, `bootstrap failed: ${boot.out}`);

  const pid1 = await waitForPid((pid) => pid > 0, "initial daemon pid");
  await waitForSocket();
  console.log(
    `DAEMON_BOOTSTRAPPED label=${label} pid=${pid1} socket=${socketPath}`,
  );

  // --- WAL durability setup: publish a durable message, leave it UNACKED. ---
  const client1 = await connectClient();
  await client1.request("mcplayer.connect", { client_id: "proof-1" });
  await waitForStatus(client1, new Set(["up"]));
  await client1.request("mcplayer.subscribe", {
    channel: "proof",
    from_offset: 1,
  });
  const pub = await client1.request("mcplayer.publish", {
    channel: "proof",
    message_id: "survive-crash-1",
    payload: { phase: "before-crash" },
    durable: true,
  });
  assert(
    (pub.result as { offset?: number }).offset === 1,
    "publish offset mismatch",
  );
  const live = await client1.next();
  assert(
    live.method === "mcplayer.message",
    "expected live delivery before crash",
  );
  console.log("PUBLISHED_DURABLE_UNACKED message_id=survive-crash-1 offset=1");

  // --- 1. KeepAlive restart-on-crash: kill -9 the daemon. ---
  process.kill(pid1, "SIGKILL");
  console.log(`SENT_SIGKILL pid=${pid1}`);
  const pid2 = await waitForPid(
    (pid) => pid > 0 && pid !== pid1,
    "respawned daemon pid",
  );
  await waitForSocket();
  assert(
    client1.isClosed(),
    "client socket should drop when the daemon crashes",
  );
  console.log(`KEEPALIVE_RESTART_OK old_pid=${pid1} new_pid=${pid2}`);

  // --- 2. WAL replay after a full daemon crash+respawn (new process). ---
  writeHeartbeat("up");
  const client2 = await connectClient();
  await client2.request("mcplayer.connect", { client_id: "proof-2" });
  await waitForStatus(client2, new Set(["up"]));
  await client2.request("mcplayer.subscribe", {
    channel: "proof",
    from_offset: 1,
  });
  const replay = await client2.next();
  const rp = replay.params as { message_id?: string; offset?: number };
  assert(replay.method === "mcplayer.message", "expected replay after respawn");
  assert(
    rp.message_id === "survive-crash-1" && rp.offset === 1,
    "replay mismatch",
  );
  await client2.request("mcplayer.ack", {
    channel: "proof",
    message_id: "survive-crash-1",
  });
  console.log(
    `WAL_REPLAY_AFTER_RESPAWN_OK message_id=${rp.message_id} offset=${rp.offset}`,
  );

  // --- 3. Live busy-state via content-aware heartbeat. ---
  writeHeartbeat("busy");
  const busy = await waitForStatus(client2, new Set(["busy"]));
  writeHeartbeat("up");
  const upAgain = await waitForStatus(client2, new Set(["up"]));
  console.log(`BUSY_STATE_OK transition=up→${busy}→${upAgain}`);

  assert(
    !client2.isClosed(),
    "client2 socket should be stable across busy-state changes",
  );
  client2.close();

  console.log(
    "DAEMON_ALWAYS_ON_OK keepalive_restart=1 wal_replay=1 busy_state=1 socket=stable",
  );
} finally {
  await launchctl("bootout", `${domain}/${label}`);
  rmSync(root, { recursive: true, force: true });
}
