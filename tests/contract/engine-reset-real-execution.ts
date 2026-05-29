import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { encodeLine, NdjsonDecoder } from "../../src/protocol";

type JsonRpcMessage = Record<string, unknown>;
type Subprocess = ReturnType<typeof Bun.spawn>;

const root = mkdtempSync(join(tmpdir(), "mcplayer-d3-real-"));
const socketPath = join(root, "mcplayer.sock");
const walPath = join(root, "queue.wal");
const heartbeatPath = join(root, "mock-engine.heartbeat");
const processes: Subprocess[] = [];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForOutput(
  process: Subprocess,
  stream: ReadableStream<Uint8Array>,
  pattern: RegExp,
  label: string,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const started = Date.now();
  try {
    while (Date.now() - started < 5000) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const line = buffer
        .split(/\r?\n/)
        .find((candidate) => pattern.test(candidate));
      if (line) return line;
    }
  } finally {
    reader.releaseLock();
  }
  const exited = await Promise.race([
    process.exited,
    sleep(1).then(() => undefined),
  ]);
  throw new Error(
    `timed out waiting for ${label}; exit=${String(exited)} output=${buffer}`,
  );
}

function startMockEngine(): Promise<Subprocess> {
  const child = Bun.spawn({
    cmd: [process.execPath, "tests/contract/mock-engine.ts"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      MCPLAYER_MOCK_ENGINE_HEARTBEAT: heartbeatPath,
    },
    stdout: "pipe",
    stderr: "inherit",
  });
  processes.push(child);
  return waitForOutput(
    child,
    child.stdout,
    /MOCK_ENGINE_READY/,
    "mock engine ready",
  ).then((line) => {
    console.log(line);
    return child;
  });
}

async function startServer(): Promise<Subprocess> {
  const child = Bun.spawn({
    cmd: [process.execPath, "bin/mcplayer-server"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      MCPLAYER_SOCKET: socketPath,
      MCPLAYER_WAL: walPath,
      MCPLAYER_ENGINE_HEARTBEAT_FILE: heartbeatPath,
      MCPLAYER_ENGINE_HEARTBEAT_STALE_MS: "120",
      MCPLAYER_ENGINE_PROBE_INTERVAL_MS: "25",
    },
    stdout: "pipe",
    stderr: "inherit",
  });
  processes.push(child);
  const line = await waitForOutput(
    child,
    child.stdout,
    /MCPLAYER_SERVER_LISTENING/,
    "mcplayer server listening",
  );
  console.log(line);
  return child;
}

async function connectClient(): Promise<{
  request: (method: string, params: Record<string, unknown>) => Promise<JsonRpcMessage>;
  next: (timeoutMs?: number) => Promise<JsonRpcMessage>;
  close: () => void;
  isClosed: () => boolean;
}> {
  const socket = net.createConnection(socketPath);
  const decoder = new NdjsonDecoder();
  const inbox: JsonRpcMessage[] = [];
  const waiters: Array<(message: JsonRpcMessage) => void> = [];
  const pending = new Map<string, (message: JsonRpcMessage) => void>();
  let nextId = 1;
  let closed = false;

  socket.on("close", () => {
    closed = true;
  });

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
    request: async (method, params) => {
      const id = nextId++;
      const response = new Promise<JsonRpcMessage>((resolve) => {
        pending.set(String(id), resolve);
      });
      socket.write(encodeLine({ jsonrpc: "2.0", id, method, params }));
      return await Promise.race([
        response,
        sleep(1000).then(() => {
          throw new Error(`timed out waiting for ${method}`);
        }),
      ]);
    },
    next: async (timeoutMs = 1000) => {
      const existing = inbox.shift();
      if (existing) return existing;
      let resolveWaiter: (message: JsonRpcMessage) => void = () => {};
      const notification = new Promise<JsonRpcMessage>((resolve) => {
        resolveWaiter = resolve;
        waiters.push(resolve);
      });
      return await Promise.race([
        notification,
        sleep(timeoutMs).then(() => {
          const index = waiters.indexOf(resolveWaiter);
          if (index !== -1) waiters.splice(index, 1);
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
): Promise<JsonRpcMessage> {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    const status = await client.request("mcplayer.status", {});
    const state = (status.result as { state?: string }).state;
    if (state && wanted.has(state)) return status;
    await sleep(25);
  }
  throw new Error(`timed out waiting for status ${[...wanted].join("/")}`);
}

try {
  const engine = await startMockEngine();
  const server = await startServer();
  const client = await connectClient();
  console.log(`CLIENT_CONNECTED socket=${socketPath}`);

  const connect = await client.request("mcplayer.connect", {
    client_id: "engine-reset-client",
  });
  assert(
    JSON.stringify(connect.result) ===
      JSON.stringify({ session_id: "engine-reset-client" }),
    "connect result mismatch",
  );

  const up = await waitForStatus(client, new Set(["up"]));
  console.log(`STATUS_UP ${JSON.stringify(up)}`);

  const subscribe = await client.request("mcplayer.subscribe", {
    channel: "engine-reset",
    from_offset: 1,
  });
  assert(
    JSON.stringify(subscribe.result) === JSON.stringify({ subscribed: true }),
    "subscribe result mismatch",
  );

  engine.kill("SIGKILL");
  const killed = await engine.exited;
  console.log(`MOCK_ENGINE_KILLED signal=SIGKILL exit=${killed}`);

  const downStarted = performance.now();
  const down = await waitForStatus(client, new Set(["not-up", "building"]));
  const downElapsed = Math.round(performance.now() - downStarted);
  const downState = (down.result as { state?: string }).state;
  console.log(`STATUS_AFTER_KILL state=${downState} elapsed_ms=${downElapsed}`);
  assert(!client.isClosed(), "client socket closed after engine kill");

  const secondClientStarted = performance.now();
  const secondClient = await connectClient();
  const secondConnect = await secondClient.request("mcplayer.connect", {
    client_id: "engine-reset-second-client",
  });
  const secondElapsed = Math.round(performance.now() - secondClientStarted);
  assert(
    JSON.stringify(secondConnect.result) ===
      JSON.stringify({ session_id: "engine-reset-second-client" }),
    "second connect result mismatch",
  );
  console.log(`CONNECT_WHILE_DOWN elapsed_ms=${secondElapsed}`);
  secondClient.close();

  const publish1 = await client.request("mcplayer.publish", {
    channel: "engine-reset",
    message_id: "during-down-1",
    payload: { order: 1 },
    durable: true,
  });
  const publish2 = await client.request("mcplayer.publish", {
    channel: "engine-reset",
    message_id: "during-down-2",
    payload: { order: 2 },
    durable: true,
  });
  assert((publish1.result as { offset?: number }).offset === 1, "offset 1 mismatch");
  assert((publish2.result as { offset?: number }).offset === 2, "offset 2 mismatch");
  console.log(
    `WAL_ENQUEUED_DURING_DOWN offsets=${(publish1.result as { offset: number }).offset},${(publish2.result as { offset: number }).offset}`,
  );

  let deliveredWhileDown = false;
  try {
    await client.next(150);
    deliveredWhileDown = true;
  } catch {
    deliveredWhileDown = false;
  }
  assert(!deliveredWhileDown, "subscriber received during-down message before recovery");
  assert(!client.isClosed(), "client socket closed while engine was down");

  const restarted = await startMockEngine();
  const recovered = await waitForStatus(client, new Set(["up"]));
  console.log(`STATUS_RECOVERED ${JSON.stringify(recovered)}`);

  const replay1 = await client.next();
  const replay2 = await client.next();
  const params1 = replay1.params as { message_id?: string; offset?: number };
  const params2 = replay2.params as { message_id?: string; offset?: number };
  assert(params1.message_id === "during-down-1", "first replay message mismatch");
  assert(params1.offset === 1, "first replay offset mismatch");
  assert(params2.message_id === "during-down-2", "second replay message mismatch");
  assert(params2.offset === 2, "second replay offset mismatch");
  assert(!client.isClosed(), "client socket closed after recovery");

  console.log(
    `ENGINE_RESET_SURVIVED socket=stable status=up replayed=2 order=${params1.message_id},${params2.message_id}`,
  );

  client.close();
  restarted.kill("SIGTERM");
  server.kill("SIGTERM");
} finally {
  for (const child of processes) {
    try {
      child.kill("SIGTERM");
    } catch {
      // best-effort cleanup
    }
  }
  rmSync(root, { recursive: true, force: true });
}
