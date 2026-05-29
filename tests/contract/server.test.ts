import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { encodeLine, NdjsonDecoder } from "../../src/protocol";
import { McplayerServer } from "../../src/server";
import { EngineSupervisor } from "../../src/server/engine";

type JsonRpcMessage = Record<string, unknown>;

const roots: string[] = [];
const servers: McplayerServer[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mcplayer-server-test-"));
  roots.push(root);
  return root;
}

async function startServer(root: string, opts: { maxRecordsPerChannel?: number } = {}) {
  const server = new McplayerServer({
    socketPath: join(root, "mcplayer.sock"),
    walPath: join(root, "queue.wal"),
    maxRecordsPerChannel: opts.maxRecordsPerChannel,
  });
  await server.start();
  servers.push(server);
  return server;
}

function connectClient(socketPath: string): Promise<{
  request: (method: string, params: Record<string, unknown>) => Promise<JsonRpcMessage>;
  next: (timeoutMs?: number) => Promise<JsonRpcMessage>;
  close: () => void;
}> {
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

  const next = (timeoutMs?: number) => {
    const existing = inbox.shift();
    if (existing) return Promise.resolve(existing);
    let resolveWaiter: (message: JsonRpcMessage) => void = () => {};
    const notification = new Promise<JsonRpcMessage>((resolve) => {
      resolveWaiter = resolve;
      waiters.push(resolve);
    });
    if (timeoutMs === undefined) return notification;
    return Promise.race([
      notification,
      new Promise<JsonRpcMessage>((_, reject) =>
        setTimeout(() => {
          const index = waiters.indexOf(resolveWaiter);
          if (index !== -1) waiters.splice(index, 1);
          reject(new Error("timed out waiting for notification"));
        }, timeoutMs),
      ),
    ]);
  };

  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve({
        request: async (method, params) => {
          const id = nextId++;
          const response = new Promise<JsonRpcMessage>((responseResolve) => {
            pending.set(String(id), responseResolve);
          });
          socket.write(encodeLine({ jsonrpc: "2.0", id, method, params }));
          return await response;
        },
        next,
        close: () => socket.end(),
      });
    });
  });
}

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()!.shutdown();
  }
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe("mcplayer D2 UDS server", () => {
  test("defaults the NDJSON bus socket away from the broker MCP proxy socket", () => {
    const server = new McplayerServer({ walPath: join(tempRoot(), "queue.wal") });

    expect(server.socketPath).toBe("/tmp/mcplayer-bus.sock");
  });

  test("connect -> publish -> subscribe -> receive mcplayer.message -> ack", async () => {
    const root = tempRoot();
    const server = await startServer(root);
    const client = await connectClient(server.socketPath);

    const connect = await client.request("mcplayer.connect", {
      client_id: "client-a",
    });
    expect(connect.result).toEqual({ session_id: "client-a" });

    const publish = await client.request("mcplayer.publish", {
      channel: "jobs",
      message_id: "m1",
      payload: { n: 1 },
      durable: true,
    });
    expect(publish.result).toEqual({ enqueued: true, offset: 1 });

    const subscribe = await client.request("mcplayer.subscribe", {
      channel: "jobs",
      from_offset: 1,
    });
    expect(subscribe.result).toEqual({ subscribed: true });

    const notification = await client.next();
    expect(notification).toEqual({
      jsonrpc: "2.0",
      method: "mcplayer.message",
      params: {
        channel: "jobs",
        message_id: "m1",
        payload: { n: 1 },
        offset: 1,
      },
    });

    const ack = await client.request("mcplayer.ack", {
      channel: "jobs",
      message_id: "m1",
    });
    expect(ack.result).toEqual({ acked: true });
    client.close();
  });

  test("restart replay resumes from offset with the same socket path", async () => {
    const root = tempRoot();
    const first = await startServer(root);
    const producer = await connectClient(first.socketPath);

    const publish = await producer.request("mcplayer.publish", {
      channel: "jobs",
      message_id: "restart-m1",
      payload: { restart: true },
    });
    expect(publish.result).toEqual({ enqueued: true, offset: 1 });
    producer.close();
    await first.shutdown();
    servers.pop();

    const second = await startServer(root);
    expect(second.socketPath).toBe(first.socketPath);
    const subscriber = await connectClient(second.socketPath);
    const subscribe = await subscriber.request("mcplayer.subscribe", {
      channel: "jobs",
      from_offset: 1,
    });
    expect(subscribe.result).toEqual({ subscribed: true });
    const replay = await subscriber.next();
    expect(replay).toEqual({
      jsonrpc: "2.0",
      method: "mcplayer.message",
      params: {
        channel: "jobs",
        message_id: "restart-m1",
        payload: { restart: true },
        offset: 1,
      },
    });
    subscriber.close();
  });

  test("subscribe replays existing offsets before later live messages", async () => {
    const root = tempRoot();
    const server = await startServer(root);
    const producer = await connectClient(server.socketPath);
    const subscriber = await connectClient(server.socketPath);

    await producer.request("mcplayer.publish", {
      channel: "ordered",
      message_id: "m1",
      payload: { order: 1 },
    });

    const subscribe = subscriber.request("mcplayer.subscribe", {
      channel: "ordered",
      from_offset: 1,
    });
    const publish = producer.request("mcplayer.publish", {
      channel: "ordered",
      message_id: "m2",
      payload: { order: 2 },
    });

    expect((await subscribe).result).toEqual({ subscribed: true });
    expect((await publish).result).toEqual({ enqueued: true, offset: 2 });
    expect((await subscriber.next()).params).toMatchObject({
      message_id: "m1",
      offset: 1,
    });
    expect((await subscriber.next()).params).toMatchObject({
      message_id: "m2",
      offset: 2,
    });

    producer.close();
    subscriber.close();
  });

  test("WalFullError becomes -32004 and status still answers afterward", async () => {
    const root = tempRoot();
    const server = await startServer(root, { maxRecordsPerChannel: 1 });
    const client = await connectClient(server.socketPath);

    expect(
      (
        await client.request("mcplayer.publish", {
          channel: "busy",
          message_id: "m1",
          payload: 1,
        })
      ).result,
    ).toEqual({ enqueued: true, offset: 1 });

    const busy = await client.request("mcplayer.publish", {
      channel: "busy",
      message_id: "m2",
      payload: 2,
    });
    expect(busy.error).toMatchObject({ code: -32004 });

    const status = await client.request("mcplayer.status", {});
    expect(status.result).toMatchObject({ state: "not-up" });
    expect(typeof (status.result as { since?: unknown }).since).toBe("string");
    client.close();
  });

  test("request errors do not poison later requests on the same connection", async () => {
    const root = tempRoot();
    const server = await startServer(root);
    const client = await connectClient(server.socketPath);

    const invalid = await client.request("mcplayer.publish", {
      channel: "jobs",
      message_id: "missing-payload",
    });
    expect(invalid.error).toMatchObject({ code: -32602 });

    const status = await client.request("mcplayer.status", {});
    expect(status.result).toMatchObject({ state: "not-up" });
    client.close();
  });

  test("attached engine drives status and gates subscriber replay until recovery", async () => {
    const root = tempRoot();
    const engine = new EngineSupervisor({ initialState: "building" });
    const server = new McplayerServer({
      socketPath: join(root, "mcplayer.sock"),
      walPath: join(root, "queue.wal"),
      engine,
    });
    await server.start();
    servers.push(server);

    const client = await connectClient(server.socketPath);
    expect((await client.request("mcplayer.status", {})).result).toMatchObject({
      state: "building",
    });

    engine.markUp();
    expect((await client.request("mcplayer.status", {})).result).toMatchObject({
      state: "up",
    });

    const subscribe = await client.request("mcplayer.subscribe", {
      channel: "engine-reset",
      from_offset: 1,
    });
    expect(subscribe.result).toEqual({ subscribed: true });

    engine.markDown();
    expect((await client.request("mcplayer.status", {})).result).toMatchObject({
      state: "not-up",
    });

    const publish = await client.request("mcplayer.publish", {
      channel: "engine-reset",
      message_id: "during-down-1",
      payload: { order: 1 },
    });
    expect(publish.result).toEqual({ enqueued: true, offset: 1 });

    engine.markUp();
    const replay = await client.next();
    expect(replay).toMatchObject({
      method: "mcplayer.message",
      params: {
        channel: "engine-reset",
        message_id: "during-down-1",
        offset: 1,
      },
    });

    client.close();
  });

  test("attached engine defers subscribe replay while down and replays on recovery", async () => {
    const root = tempRoot();
    const engine = new EngineSupervisor({ initialState: "not-up" });
    const server = new McplayerServer({
      socketPath: join(root, "mcplayer.sock"),
      walPath: join(root, "queue.wal"),
      engine,
    });
    await server.start();
    servers.push(server);

    const producer = await connectClient(server.socketPath);
    const subscriber = await connectClient(server.socketPath);
    await producer.request("mcplayer.publish", {
      channel: "deferred-replay",
      message_id: "m1",
      payload: { order: 1 },
    });

    const subscribe = await subscriber.request("mcplayer.subscribe", {
      channel: "deferred-replay",
      from_offset: 1,
    });
    expect(subscribe.result).toEqual({ subscribed: true });

    await expect(subscriber.next(25)).rejects.toThrow(
      "timed out waiting for notification",
    );

    engine.markUp();
    const replay = await subscriber.next();
    expect(replay).toMatchObject({
      method: "mcplayer.message",
      params: {
        channel: "deferred-replay",
        message_id: "m1",
        offset: 1,
      },
    });

    producer.close();
    subscriber.close();
  });
});
