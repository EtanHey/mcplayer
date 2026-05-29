import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodeLine, NdjsonDecoder } from "../../src/protocol";

type JsonRpcMessage = Record<string, unknown>;
type JsonRpcError = { code: number; message: string; data?: unknown };
type ReceivedMessage = {
  channel: string;
  message_id: string;
  payload: { publisher: number; sequence: number; sent_at_ms: number };
  offset: number;
};

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const SERVER_BIN = path.join(REPO_ROOT, "bin", "mcplayer-server");
const PUBLISHER_COUNT = 10;
const SUBSCRIBER_COUNT = 10;
const MESSAGES_PER_PUBLISHER = 100;
const BACKPRESSURE_CAP = MESSAGES_PER_PUBLISHER;
const BACKPRESSURE_NACK_ATTEMPTS = 20;
const WALL_CLOCK_LIMIT_MS = 20_000;

const children: ChildProcessWithoutNullStreams[] = [];
const roots: string[] = [];

class BusClient {
  readonly socketPath: string;
  #socket: net.Socket;
  #decoder = new NdjsonDecoder();
  #pending = new Map<string, (message: JsonRpcMessage) => void>();
  #notifications: JsonRpcMessage[] = [];
  #waiters: Array<() => void> = [];
  #nextId = 1;
  #closed = false;

  private constructor(socketPath: string, socket: net.Socket) {
    this.socketPath = socketPath;
    this.#socket = socket;
    this.#socket.on("data", (chunk) => this.#handleData(chunk));
    this.#socket.on("close", () => {
      this.#closed = true;
      this.#wake();
    });
    this.#socket.on("error", () => {
      this.#closed = true;
      this.#wake();
    });
  }

  static connect(socketPath: string): Promise<BusClient> {
    const socket = net.createConnection(socketPath);
    return new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.off("error", reject);
        resolve(new BusClient(socketPath, socket));
      });
    });
  }

  async request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 5_000,
  ): Promise<JsonRpcMessage> {
    const id = this.#nextId++;
    const response = new Promise<JsonRpcMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(String(id));
        reject(new Error(`timed out waiting for ${method} response id=${id}`));
      }, timeoutMs);
      this.#pending.set(String(id), (message) => {
        clearTimeout(timeout);
        resolve(message);
      });
    });
    this.#socket.write(encodeLine({ jsonrpc: "2.0", id, method, params }));
    return await response;
  }

  async waitForNotifications(
    count: number,
    timeoutMs: number,
  ): Promise<JsonRpcMessage[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.#notifications.length < count) {
      if (this.#closed) {
        throw new Error(
          `socket closed with ${this.#notifications.length}/${count} notifications`,
        );
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          `timed out with ${this.#notifications.length}/${count} notifications`,
        );
      }
      await this.#waitForChange(remainingMs);
    }
    return this.#notifications.splice(0, count);
  }

  close(): void {
    this.#socket.end();
  }

  #handleData(chunk: Buffer): void {
    for (const message of this.#decoder.push(chunk) as JsonRpcMessage[]) {
      const id = message.id;
      if (
        (typeof id === "string" || typeof id === "number" || id === null) &&
        this.#pending.has(String(id))
      ) {
        this.#pending.get(String(id))!(message);
        this.#pending.delete(String(id));
        continue;
      }
      this.#notifications.push(message);
    }
    this.#wake();
  }

  #waitForChange(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#waiters = this.#waiters.filter((waiter) => waiter !== onWake);
        reject(new Error("timed out waiting for socket activity"));
      }, timeoutMs);
      const onWake = () => {
        clearTimeout(timeout);
        resolve();
      };
      this.#waiters.push(onWake);
    });
  }

  #wake(): void {
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) waiter();
  }
}

afterEach(async () => {
  while (children.length > 0) {
    await stopServer(children.pop()!);
  }
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

test(
  "live mcplayer-server handles N=10 bus concurrency, ordering, and backpressure",
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "mcplayer-concurrency-"));
    roots.push(root);
    const socketPath = path.join(root, "mcplayer.sock");
    const walPath = path.join(root, "queue.wal");
    const server = await startServer(socketPath, walPath);
    children.push(server);

    const startedAt = Date.now();
    const latencies: number[] = [];
    let sent = 0;
    let received = 0;
    let reordered = 0;
    let nacks = 0;

    const subscribers = await Promise.all(
      Array.from({ length: SUBSCRIBER_COUNT }, async (_, index) => {
        const client = await BusClient.connect(socketPath);
        await expectOk(
          client.request("mcplayer.connect", {
            client_id: `subscriber-${index}`,
          }),
        );
        await expectOk(
          client.request("mcplayer.subscribe", {
            channel: channelName(index),
            from_offset: 1,
          }),
        );
        return client;
      }),
    );

    const publishers = await Promise.all(
      Array.from({ length: PUBLISHER_COUNT }, async (_, index) => {
        const client = await BusClient.connect(socketPath);
        await expectOk(
          client.request("mcplayer.connect", {
            client_id: `publisher-${index}`,
          }),
        );
        return client;
      }),
    );

    const receiveMain = Promise.all(
      subscribers.map(async (subscriber, publisherIndex) => {
        const messages = await subscriber.waitForNotifications(
          MESSAGES_PER_PUBLISHER,
          WALL_CLOCK_LIMIT_MS,
        );
        let previousOffset = 0;
        for (const message of messages) {
          const params = decodeMessage(message);
          const expectedMessageId = messageId(publisherIndex, params.payload.sequence);
          if (params.channel !== channelName(publisherIndex)) {
            throw new Error(`cross-channel delivery on ${params.channel}`);
          }
          if (params.payload.publisher !== publisherIndex) {
            throw new Error(`publisher correlation mismatch ${params.message_id}`);
          }
          if (params.message_id !== expectedMessageId) {
            throw new Error(
              `message_id correlation mismatch: got ${params.message_id}, expected ${expectedMessageId}`,
            );
          }
          if (params.offset !== params.payload.sequence) {
            throw new Error(`offset/sequence correlation mismatch ${params.message_id}`);
          }
          if (params.offset <= previousOffset) reordered += 1;
          previousOffset = params.offset;
          latencies.push(Date.now() - params.payload.sent_at_ms);
          received += 1;
        }
      }),
    );

    await bounded(
      Promise.all(
        publishers.map(async (publisher, publisherIndex) => {
          for (let sequence = 1; sequence <= MESSAGES_PER_PUBLISHER; sequence += 1) {
            const response = await publisher.request("mcplayer.publish", {
              channel: channelName(publisherIndex),
              message_id: messageId(publisherIndex, sequence),
              payload: {
                publisher: publisherIndex,
                sequence,
                sent_at_ms: Date.now(),
              },
              durable: true,
            });
            expect(response.error).toBeUndefined();
            expect((response.result as { offset?: number }).offset).toBe(sequence);
            sent += 1;
          }
        }),
      ),
      WALL_CLOCK_LIMIT_MS,
      "10 concurrent publishers stalled",
    );

    await bounded(receiveMain, WALL_CLOCK_LIMIT_MS, "10 subscribers stalled");

    const backpressureSubscriber = await BusClient.connect(socketPath);
    const backpressurePublisher = await BusClient.connect(socketPath);
    await expectOk(
      backpressureSubscriber.request("mcplayer.connect", {
        client_id: "backpressure-subscriber",
      }),
    );
    await expectOk(
      backpressurePublisher.request("mcplayer.connect", {
        client_id: "backpressure-publisher",
      }),
    );
    await expectOk(
      backpressureSubscriber.request("mcplayer.subscribe", {
        channel: "backpressure",
        from_offset: 1,
      }),
    );

    for (let sequence = 1; sequence <= BACKPRESSURE_CAP; sequence += 1) {
      const response = await backpressurePublisher.request("mcplayer.publish", {
        channel: "backpressure",
        message_id: `bp-${sequence}`,
        payload: { publisher: 999, sequence, sent_at_ms: Date.now() },
      });
      expect(response.error).toBeUndefined();
      sent += 1;
    }

    for (
      let sequence = BACKPRESSURE_CAP + 1;
      sequence <= BACKPRESSURE_CAP + BACKPRESSURE_NACK_ATTEMPTS;
      sequence += 1
    ) {
      const response = await backpressurePublisher.request("mcplayer.publish", {
        channel: "backpressure",
        message_id: `bp-${sequence}`,
        payload: { publisher: 999, sequence, sent_at_ms: Date.now() },
      });
      expect((response.error as JsonRpcError | undefined)?.code).toBe(-32004);
      nacks += 1;
    }

    const backpressureFill = await backpressureSubscriber.waitForNotifications(
      BACKPRESSURE_CAP,
      WALL_CLOCK_LIMIT_MS,
    );
    for (let index = 0; index < backpressureFill.length; index += 1) {
      const params = decodeMessage(backpressureFill[index]);
      expect(params.channel).toBe("backpressure");
      expect(params.offset).toBe(index + 1);
      expect(params.message_id).toBe(`bp-${index + 1}`);
      latencies.push(Date.now() - params.payload.sent_at_ms);
      received += 1;
      await expectOk(
        backpressureSubscriber.request("mcplayer.ack", {
          channel: "backpressure",
          message_id: params.message_id,
        }),
      );
    }

    const recoverySentAt = Date.now();
    const recovery = await backpressurePublisher.request("mcplayer.publish", {
      channel: "backpressure",
      message_id: "bp-recovery",
      payload: { publisher: 999, sequence: BACKPRESSURE_CAP + 1, sent_at_ms: recoverySentAt },
    });
    expect(recovery.error).toBeUndefined();
    sent += 1;
    const [recovered] = await backpressureSubscriber.waitForNotifications(
      1,
      WALL_CLOCK_LIMIT_MS,
    );
    const recoveredParams = decodeMessage(recovered);
    expect(recoveredParams.message_id).toBe("bp-recovery");
    expect(recoveredParams.offset).toBe(BACKPRESSURE_CAP + 1);
    latencies.push(Date.now() - recoveredParams.payload.sent_at_ms);
    received += 1;

    const wallMs = Date.now() - startedAt;
    const lost = sent - received;
    expect(lost).toBe(0);
    expect(reordered).toBe(0);
    expect(nacks).toBe(BACKPRESSURE_NACK_ATTEMPTS);
    expect(wallMs).toBeLessThan(WALL_CLOCK_LIMIT_MS);

    for (const client of [...subscribers, ...publishers, backpressureSubscriber, backpressurePublisher]) {
      client.close();
    }

    const p50Ms = percentile(latencies, 50);
    const p99Ms = percentile(latencies, 99);
    console.log(
      `CONCURRENCY_N10_OK sent=${sent} received=${received} lost=${lost} reordered=${reordered} p50_ms=${p50Ms} p99_ms=${p99Ms} nacks=${nacks} wall_ms=${wallMs}`,
    );
  },
  WALL_CLOCK_LIMIT_MS + 10_000,
);

async function startServer(
  socketPath: string,
  walPath: string,
): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(process.execPath, [SERVER_BIN], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      MCPLAYER_SOCKET: socketPath,
      MCPLAYER_WAL: walPath,
      MCPLAYER_WAL_MAX_RECORDS_PER_CHANNEL: String(BACKPRESSURE_CAP),
    },
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  await waitFor(
    () => stdout.includes("MCPLAYER_SERVER_LISTENING"),
    5_000,
    () => `mcplayer-server did not start. stdout=${stdout} stderr=${stderr}`,
  );
  return child;
}

async function stopServer(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  errorMessage: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(errorMessage());
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function bounded<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(label)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function expectOk(responsePromise: Promise<JsonRpcMessage>): Promise<void> {
  const response = await responsePromise;
  expect(response.error).toBeUndefined();
}

function decodeMessage(message: JsonRpcMessage): ReceivedMessage {
  expect(message.method).toBe("mcplayer.message");
  const params = message.params as ReceivedMessage;
  expect(typeof params.channel).toBe("string");
  expect(typeof params.message_id).toBe("string");
  expect(typeof params.offset).toBe("number");
  return params;
}

function channelName(publisherIndex: number): string {
  return `concurrency-${publisherIndex}`;
}

function messageId(publisherIndex: number, sequence: number): string {
  return `pub-${publisherIndex}-seq-${sequence}`;
}

function percentile(values: number[], percentileValue: number): number {
  expect(values.length).toBeGreaterThan(0);
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((percentileValue / 100) * sorted.length) - 1,
  );
  return sorted[index];
}
