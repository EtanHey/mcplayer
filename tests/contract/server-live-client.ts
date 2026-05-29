import net from "node:net";
import { encodeLine, NdjsonDecoder } from "../../src/protocol";

type JsonRpcMessage = Record<string, unknown>;

const mode = process.argv[2] ?? "roundtrip";
const socketPath = process.env.MCPLAYER_SOCKET ?? "/tmp/mcplayer-bus.sock";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function connectClient() {
  const socket = net.createConnection(socketPath);
  const decoder = new NdjsonDecoder();
  const inbox: JsonRpcMessage[] = [];
  const waiters: Array<(message: JsonRpcMessage) => void> = [];
  const pending = new Map<string, (message: JsonRpcMessage) => void>();
  let nextId = 1;

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

  const next = () =>
    new Promise<JsonRpcMessage>((resolve) => {
      const existing = inbox.shift();
      if (existing) resolve(existing);
      else waiters.push(resolve);
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
      const response = new Promise<JsonRpcMessage>((resolve) => {
        pending.set(String(id), resolve);
      });
      socket.write(encodeLine({ jsonrpc: "2.0", id, method, params }));
      return await response;
    },
    next,
    close: () => socket.end(),
  };
}

if (mode === "roundtrip") {
  const client = await connectClient();
  console.log(`CLIENT_CONNECTED socket=${socketPath}`);
  const connect = await client.request("mcplayer.connect", {
    client_id: "live-client",
  });
  console.log(`CONNECT_RESPONSE ${JSON.stringify(connect)}`);
  assert(
    JSON.stringify(connect.result) ===
      JSON.stringify({ session_id: "live-client" }),
    "connect returned unexpected result",
  );

  const publish = await client.request("mcplayer.publish", {
    channel: "live",
    message_id: "live-m1",
    payload: { hello: "bus" },
    durable: true,
  });
  console.log(`PUBLISH_RESPONSE ${JSON.stringify(publish)}`);
  assert(
    (publish.result as { offset?: number }).offset === 1,
    "publish offset mismatch",
  );

  const subscribe = await client.request("mcplayer.subscribe", {
    channel: "live",
    from_offset: 1,
  });
  console.log(`SUBSCRIBE_RESPONSE ${JSON.stringify(subscribe)}`);
  assert(
    JSON.stringify(subscribe.result) === JSON.stringify({ subscribed: true }),
    "subscribe returned unexpected result",
  );

  const notification = await client.next();
  console.log(`MESSAGE_NOTIFICATION ${JSON.stringify(notification)}`);
  assert(notification.method === "mcplayer.message", "expected mcplayer.message");

  const ack = await client.request("mcplayer.ack", {
    channel: "live",
    message_id: "live-m1",
  });
  console.log(`ACK_RESPONSE ${JSON.stringify(ack)}`);
  assert(
    JSON.stringify(ack.result) === JSON.stringify({ acked: true }),
    "ack mismatch",
  );

  const status = await client.request("mcplayer.status", {});
  console.log(`STATUS_RESPONSE ${JSON.stringify(status)}`);
  assert((status.result as { state?: string }).state === "not-up", "status mismatch");
  client.close();
  console.log("LIVE_ROUNDTRIP_OK");
} else if (mode === "publish-unacked") {
  const client = await connectClient();
  console.log(`CLIENT_CONNECTED socket=${socketPath}`);
  const publish = await client.request("mcplayer.publish", {
    channel: "replay",
    message_id: "replay-m1",
    payload: { replay: true },
  });
  console.log(`UNACKED_PUBLISH_RESPONSE ${JSON.stringify(publish)}`);
  assert((publish.result as { offset?: number }).offset === 1, "publish offset mismatch");
  client.close();
  console.log("UNACKED_PUBLISH_OK");
} else if (mode === "replay") {
  const client = await connectClient();
  console.log(`CLIENT_CONNECTED socket=${socketPath}`);
  const subscribe = await client.request("mcplayer.subscribe", {
    channel: "replay",
    from_offset: 1,
  });
  console.log(`REPLAY_SUBSCRIBE_RESPONSE ${JSON.stringify(subscribe)}`);
  assert(
    JSON.stringify(subscribe.result) === JSON.stringify({ subscribed: true }),
    "subscribe returned unexpected result",
  );
  const notification = await client.next();
  console.log(`REPLAY_NOTIFICATION ${JSON.stringify(notification)}`);
  assert(notification.method === "mcplayer.message", "expected replay notification");
  const params = notification.params as { message_id?: string; offset?: number };
  assert(params.message_id === "replay-m1", "unexpected replay message_id");
  assert(params.offset === 1, "unexpected replay offset");
  client.close();
  console.log("RESTART_REPLAY_OK");
} else {
  throw new Error(`unknown mode: ${mode}`);
}
