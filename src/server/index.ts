import { randomUUID } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ERR,
  NdjsonDecoder,
  classify,
  encodeLine,
  validateParams,
} from "../protocol";
import { DurableQueue, WalFullError, type WalRecord } from "../wal";

type BunSocket = any;
type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

interface ClientConnection {
  id: string;
  socket: BunSocket;
  decoder: NdjsonDecoder;
  closed: boolean;
  subscriptions: Set<string>;
  operations: Promise<void>;
  writes: Promise<void>;
  parseErrorCount: number;
}

interface Subscription {
  client: ClientConnection;
  channel: string;
  fromOffset: number;
}

export interface McplayerServerOptions {
  socketPath?: string;
  walPath?: string;
  maxBytesPerChannel?: number;
  maxRecordsPerChannel?: number;
}

export class McplayerServer {
  readonly #socketPath: string;
  readonly #walPath: string;
  readonly #maxBytesPerChannel?: number;
  readonly #maxRecordsPerChannel?: number;
  readonly #sessionsByClientId = new Map<string, string>();
  readonly #clients = new Map<BunSocket, ClientConnection>();
  readonly #subscriptions = new Map<string, Subscription>();
  readonly #engineSince = new Date().toISOString();
  #server: any;
  #queue?: DurableQueue;
  #queueOperations: Promise<void> = Promise.resolve();
  #stopping = false;

  constructor(opts: McplayerServerOptions = {}) {
    this.#socketPath =
      opts.socketPath ??
      process.env.MCPLAYER_SOCKET ??
      "/tmp/mcplayer-bus.sock";
    this.#walPath =
      opts.walPath ??
      process.env.MCPLAYER_WAL ??
      join(tmpdir(), "mcplayer.queue.wal");
    this.#maxBytesPerChannel = opts.maxBytesPerChannel;
    this.#maxRecordsPerChannel = opts.maxRecordsPerChannel;
  }

  get socketPath(): string {
    return this.#socketPath;
  }

  get walPath(): string {
    return this.#walPath;
  }

  async start(): Promise<void> {
    if (this.#server) return;

    rmSync(this.#socketPath, { force: true });
    this.#queue = DurableQueue.open({
      path: this.#walPath,
      maxBytesPerChannel: this.#maxBytesPerChannel,
      maxRecordsPerChannel: this.#maxRecordsPerChannel,
    });

    this.#server = Bun.listen({
      unix: this.#socketPath,
      socket: {
        open: (socket: BunSocket) => this.#handleOpen(socket),
        data: (socket: BunSocket, data: Uint8Array) =>
          this.#handleData(socket, data),
        close: (socket: BunSocket) => this.#handleClose(socket),
        error: (socket: BunSocket) => this.#handleClose(socket),
      },
    });

    chmodSync(this.#socketPath, 0o600);
  }

  async shutdown(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;

    try {
      this.#server?.stop(true);
    } finally {
      this.#server = undefined;
    }

    for (const client of this.#clients.values()) {
      try {
        client.closed = true;
        client.socket.end();
      } catch {
        // best-effort socket cleanup
      }
    }
    this.#clients.clear();
    this.#subscriptions.clear();

    try {
      this.#queue?.close();
    } finally {
      this.#queue = undefined;
      rmSync(this.#socketPath, { force: true });
      this.#stopping = false;
    }
  }

  #handleOpen(socket: BunSocket): void {
    const client: ClientConnection = {
      id: randomUUID(),
      socket,
      decoder: new NdjsonDecoder(),
      closed: false,
      subscriptions: new Set(),
      operations: Promise.resolve(),
      writes: Promise.resolve(),
      parseErrorCount: 0,
    };
    this.#clients.set(socket, client);
  }

  #handleClose(socket: BunSocket): void {
    const client = this.#clients.get(socket);
    if (!client) return;
    client.closed = true;
    for (const key of client.subscriptions) {
      this.#subscriptions.delete(key);
    }
    this.#clients.delete(socket);
  }

  #handleData(socket: BunSocket, data: Uint8Array): void {
    const client = this.#clients.get(socket);
    if (!client || client.closed) return;

    const messages = client.decoder.push(data);
    const newParseErrors = client.decoder.errors.slice(client.parseErrorCount);
    client.parseErrorCount = client.decoder.errors.length;

    client.operations = client.operations
      .then(async () => {
        for (const parseError of newParseErrors) {
          await this.#sendError(client, null, -32700, parseError.error);
        }

        for (const message of messages) {
          await this.#handleMessage(client, message);
        }
      })
      .catch(async (error) => {
        try {
          await this.#sendError(
            client,
            null,
            -32603,
            error instanceof Error ? error.message : String(error),
          );
        } catch {
          this.#handleClose(socket);
        }
      });
  }

  async #handleMessage(client: ClientConnection, message: unknown): Promise<void> {
    const kind = classify(message);
    if (kind === "notification" || kind === "response") return;
    if (kind !== "request") {
      await this.#sendError(client, extractId(message), -32600, "invalid request");
      return;
    }

    const request = message as JsonRpcRequest;
    if (!isKnownMethod(request.method)) {
      await this.#sendError(client, request.id, -32601, "method not found");
      return;
    }

    const validation = validateParams(request.method, request.params);
    if (!validation.ok) {
      await this.#sendError(
        client,
        request.id,
        -32602,
        validation.error ?? "invalid params",
      );
      return;
    }

    try {
      await this.#dispatch(client, request);
    } catch (error) {
      if (error instanceof WalFullError) {
        await this.#sendError(client, request.id, ERR.WAL_FULL, "WAL full", {
          channel: error.channel,
        });
        return;
      }

      await this.#sendError(
        client,
        request.id,
        -32603,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async #dispatch(
    client: ClientConnection,
    request: JsonRpcRequest,
  ): Promise<void> {
    const params = request.params as Record<string, unknown>;
    switch (request.method) {
      case "mcplayer.connect": {
        const clientId = params.client_id as string;
        let sessionId = this.#sessionsByClientId.get(clientId);
        if (!sessionId) {
          sessionId = clientId;
          this.#sessionsByClientId.set(clientId, sessionId);
        }
        await this.#sendResult(client, request.id, { session_id: sessionId });
        return;
      }

      case "mcplayer.publish": {
        await this.#runQueueOperation(async () => {
          const channel = params.channel as string;
          const messageId = params.message_id as string;
          const payload = params.payload;
          const { offset } = this.#requireQueue().append(
            channel,
            messageId,
            payload,
          );
          await this.#sendResult(client, request.id, { enqueued: true, offset });
          await this.#notifySubscribers({
            channel,
            message_id: messageId,
            payload,
            offset,
          });
        });
        return;
      }

      case "mcplayer.subscribe": {
        await this.#runQueueOperation(async () => {
          const channel = params.channel as string;
          const fromOffset =
            typeof params.from_offset === "number" ? params.from_offset : 1;
          const records = this.#requireQueue().readFrom(channel, fromOffset);
          await this.#sendResult(client, request.id, { subscribed: true });
          for (const record of records) {
            await this.#sendMessageBestEffort(client, record);
          }
          if (client.closed) return;

          const key = `${client.id}:${channel}`;
          this.#subscriptions.set(key, { client, channel, fromOffset });
          client.subscriptions.add(key);
        });
        return;
      }

      case "mcplayer.ack": {
        await this.#runQueueOperation(async () => {
          this.#requireQueue().ack(
            params.channel as string,
            params.message_id as string,
          );
          await this.#sendResult(client, request.id, { acked: true });
        });
        return;
      }

      case "mcplayer.status":
        // This is engine health, not listener health. D2 has no attached engine yet.
        await this.#sendResult(client, request.id, {
          state: "not-up",
          since: this.#engineSince,
        });
        return;
    }
  }

  #requireQueue(): DurableQueue {
    if (!this.#queue) throw new Error("DurableQueue is not open");
    return this.#queue;
  }

  async #runQueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#queueOperations.then(operation, operation);
    this.#queueOperations = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }

  async #notifySubscribers(record: WalRecord): Promise<void> {
    for (const subscription of this.#subscriptions.values()) {
      if (subscription.channel !== record.channel) continue;
      if (record.offset < subscription.fromOffset) continue;
      await this.#sendMessageBestEffort(subscription.client, record);
    }
  }

  async #sendMessageBestEffort(
    client: ClientConnection,
    record: WalRecord,
  ): Promise<void> {
    try {
      await this.#sendMessage(client, record);
    } catch {
      this.#handleClose(client.socket);
    }
  }

  #sendMessage(client: ClientConnection, record: WalRecord): Promise<void> {
    return this.#send(client, {
      jsonrpc: "2.0",
      method: "mcplayer.message",
      params: {
        channel: record.channel,
        message_id: record.message_id,
        payload: record.payload,
        offset: record.offset,
      },
    });
  }

  #sendResult(
    client: ClientConnection,
    id: JsonRpcId,
    result: Record<string, unknown>,
  ): Promise<void> {
    return this.#send(client, { jsonrpc: "2.0", id, result });
  }

  #sendError(
    client: ClientConnection,
    id: JsonRpcId,
    code: number,
    message: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    return this.#send(client, {
      jsonrpc: "2.0",
      id,
      error: data ? { code, message, data } : { code, message },
    });
  }

  #send(client: ClientConnection, value: unknown): Promise<void> {
    client.writes = client.writes.then(async () => {
      if (!client.closed) client.socket.write(encodeLine(value));
    });
    return client.writes;
  }
}

function isKnownMethod(method: string): boolean {
  return (
    method === "mcplayer.connect" ||
    method === "mcplayer.publish" ||
    method === "mcplayer.subscribe" ||
    method === "mcplayer.ack" ||
    method === "mcplayer.status"
  );
}

function extractId(message: unknown): JsonRpcId {
  if (
    typeof message === "object" &&
    message !== null &&
    "id" in message &&
    ((message as { id?: unknown }).id === null ||
      typeof (message as { id?: unknown }).id === "string" ||
      typeof (message as { id?: unknown }).id === "number")
  ) {
    return (message as { id: JsonRpcId }).id;
  }
  return null;
}
