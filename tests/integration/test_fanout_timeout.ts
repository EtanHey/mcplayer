import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  accessSync,
  readFileSync,
  rmSync,
  mkdtempSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { McpFrameReader, encodeMcpMessage } from "../../src/mcp-framing";

const FIXTURE_PATH = path.join(process.cwd(), "tests", "fixtures", "fanout_timeout_payload.json");
const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const SERVICE_SOCKET_PATH = "/tmp/mcplayer-fanout-timeout.sock";

type JsonRpcMessage = Record<string, unknown>;

interface FanoutCall {
  id: number;
  name: string;
  arguments: {
    delay_ms: number;
  };
  expected_status_code: number;
  expected: {
    kind: "result" | "error";
    status_code: number;
  };
}

interface FanoutFixture {
  target: string;
  request_timeout_ms: number;
  requests: FanoutCall[];
}

interface TimedResponse {
  message: JsonRpcMessage;
  receivedAt: number;
}

let daemonProcess: ChildProcess | undefined;
let tempDir: string;
let configPath: string;

beforeAll(async () => {
  const fixture = loadFixture();
  if (!fixture) {
    throw new Error(`failed to load fixture at ${FIXTURE_PATH}`);
  }

  tempDir = mkdtempSync(path.join(tmpdir(), "mcplayer-fanout-timeout."));
  configPath = path.join(tempDir, "config.json");

  const bunPath = whichBinary("bun") ?? "bun";

  writeFileSync(
    configPath,
    JSON.stringify(
      {
        socketPath: SERVICE_SOCKET_PATH,
        brainbarSocketPath: "/tmp/mcplayer-brainbar-sock-does-not-exist.sock",
        logProject: "mcplayer-fanout-timeout",
        logTags: ["mcplayer-test", "fanout-timeout"],
        servers: {
          [fixture.target]: {
            command: bunPath,
            args: [path.join(REPO_ROOT, "tests/integration/fanout-timeout-upstream.ts")],
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  daemonProcess = spawn(bunPath, ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      MCPLAYER_DISABLE_BRAINBAR_LOGS: "1",
      MCPLAYER_CONFIG_PATH: configPath,
      MCPLAYER_SOCKET_PATH: SERVICE_SOCKET_PATH,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  await waitFor(() => existsSync(SERVICE_SOCKET_PATH), 10_000, "daemon socket bind");
});

afterAll(async () => {
  if (daemonProcess && daemonProcess.pid) {
    try {
      daemonProcess.kill("SIGTERM");
    } catch {
      // ignore cleanup errors
    }
    await waitPidExit(daemonProcess.pid, 3_000);
  }

  if (configPath) {
    rmSync(configPath, { force: true });
  }
  if (tempDir) {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("mcplayer fan-out fixture validates timeout and invalid-name failures", async () => {
  const fixture = loadFixture();
  expect(Array.isArray(fixture.requests)).toBe(true);
  expect(fixture.requests).toHaveLength(100);

  const client = new BunMcpClient(fixture.target, SERVICE_SOCKET_PATH);
  await client.connect();

  const sendAtByRequestId = new Map<number, number>();
  const responseDeadlineMs = 20_000;
  const responses = await client.sendAndCollect(fixture, sendAtByRequestId, responseDeadlineMs);

  expect(responses).toHaveLength(fixture.requests.length + 1);

  const within500Ms: number[] = [];
  const responseById = new Map<number, TimedResponse>();

  for (const response of responses) {
    const id = response.message.id;
    if (typeof id === "number" && id > 0) {
      responseById.set(id, response);
      const started = sendAtByRequestId.get(id);
      if (typeof started === "number" && Number.isFinite(started)) {
        within500Ms.push(response.receivedAt - started);
      }
    }
  }

  const expectedCallCount = fixture.requests.length;
  const completedInWindow = within500Ms.filter((ms) => ms <= fixture.request_timeout_ms);

  expect(responseById.size).toBe(expectedCallCount);
  expect(completedInWindow.length / expectedCallCount).toBeGreaterThanOrEqual(0.95);

  let timeoutErrorCount = 0;
  for (const call of fixture.requests) {
    const response = responseById.get(call.id);
    expect(response).toBeDefined();

    if (!response) {
      continue;
    }

    const payload = response.message;
    const actualStatusCode = payload.error
      ? Number((payload.error as Record<string, unknown>).code)
      : 200;

    expect(actualStatusCode).toBe(call.expected_status_code);
    expect(!!payload.error).toBe(call.expected.kind === "error");

    const started = sendAtByRequestId.get(call.id);
    if (call.expected.kind === "error" && call.expected.status_code === -32000) {
      timeoutErrorCount += 1;
      expect(started).toBeTypeOf("number");
      expect(response.receivedAt - (started ?? 0)).toBeGreaterThan(fixture.request_timeout_ms);
    }
  }

  expect(timeoutErrorCount).toBeGreaterThan(0);
  await client.close();
});

class BunMcpClient {
  readonly target: string;
  readonly socketPath: string;
  #socket: any;
  #reader = new McpFrameReader();
  #messages: JsonRpcMessage[] = [];
  #responses: Map<number, number> = new Map();
  #waiters: Array<() => void> = [];
  #drainWaiters: Array<() => void> = [];
  #errors: Error[] = [];

  constructor(target: string, socketPath: string) {
    this.target = target;
    this.socketPath = socketPath;
  }

  async connect(): Promise<void> {
    this.#socket = await Bun.connect({
      unix: this.socketPath,
      socket: {
        data: (_socket, chunk) => {
          const messages = this.#reader.push(Buffer.from(chunk));
          for (const message of messages) {
            const payload = message as JsonRpcMessage;
            this.#messages.push(payload);
            if (typeof payload.id === "number") {
              this.#responses.set(payload.id, Date.now());
            }
          }
          this.#wake();
        },
        drain: () => {
          this.#wakeDrain();
        },
        close: () => {
          this.#wake();
          this.#wakeDrain();
        },
        error: (_socket, error) => {
          this.#errors.push(error);
          this.#wake();
          this.#wakeDrain();
        },
        connectError: (_socket, error) => {
          this.#errors.push(error);
          this.#wake();
          this.#wakeDrain();
        },
      },
    });
  }

  async sendAndCollect(
    fixture: FanoutFixture,
    sendAtByRequestId: Map<number, number>,
    timeoutMs: number,
  ): Promise<TimedResponse[]> {
    const initialize = encodeMcpMessage({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: {
          name: "fanout-timeout-suite",
          version: "1.0.0",
        },
      },
    });

    const notifications = encodeMcpMessage({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    const calls: Uint8Array[] = fixture.requests.map((call) => {
      sendAtByRequestId.set(call.id, Date.now());
      return encodeMcpMessage({
        jsonrpc: "2.0",
        id: call.id,
        method: "tools/call",
        params: {
          name: call.name,
          arguments: {
            delay_ms: call.arguments.delay_ms,
          },
        },
      });
    });

    await this.#writeFrameFully(Buffer.from(`TARGET:${fixture.target}\n`, "utf8"));
    await this.#writeFrameFully(initialize);
    await this.#writeFrameFully(notifications);

    for (const frame of calls) {
      await this.#writeFrameFully(frame);
    }

    const responses = await this.waitForResponses(fixture.requests.length + 1, timeoutMs);
    return responses;
  }

  async waitForResponses(expectedCount: number, timeoutMs: number): Promise<TimedResponse[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.#messages.length < expectedCount) {
      if (this.#errors.length > 0) {
        throw this.#errors[0];
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(`timed out after ${timeoutMs}ms with ${this.#messages.length}/${expectedCount} responses`);
      }
      await this.#waitForChange(remainingMs);
    }

    return this.#messages.map((message) => ({
      message,
      receivedAt: typeof message.id === "number" && this.#responses.has(message.id)
        ? (this.#responses.get(message.id) as number)
        : Date.now(),
    }));
  }

  async close(): Promise<void> {
    if (this.#socket) {
      this.#socket.end();
    }
  }

  async #writeFrameFully(frame: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < frame.length) {
      const written = this.#socket.write(frame.subarray(offset));
      if (written < 0) {
        throw new Error(`socket write failed with ${written}`);
      }
      if (written === 0) {
        await this.#waitForDrain(5_000);
        continue;
      }
      offset += written;
    }
  }

  #waitForChange(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#waiters = this.#waiters.filter((waiter) => waiter !== onWake);
        reject(new Error("timed out waiting for mcp response"));
      }, timeoutMs);

      const onWake = () => {
        clearTimeout(timeout);
        resolve();
      };

      this.#waiters.push(onWake);
    });
  }

  #waitForDrain(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#drainWaiters = this.#drainWaiters.filter((waiter) => waiter !== onDrain);
        reject(new Error("timed out waiting for socket drain"));
      }, timeoutMs);

      const onDrain = () => {
        clearTimeout(timeout);
        resolve();
      };

      this.#drainWaiters.push(onDrain);
    });
  }

  #wake(): void {
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) {
      waiter();
    }
  }

  #wakeDrain(): void {
    const waiters = this.#drainWaiters.splice(0);
    for (const waiter of waiters) {
      waiter();
    }
  }
}

function loadFixture(): FanoutFixture {
  accessSync(FIXTURE_PATH);
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as FanoutFixture;
}

function whichBinary(name: string): string {
  const result = spawnSync(name, ["--version"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`binary ${name} is unavailable in test environment`);
  }

  return name;
}

function waitFor(predicate: () => boolean, timeoutMs: number, description: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const pollMs = 50;
  return new Promise((resolve, reject) => {
    const check = async () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`timed out waiting for ${description}`));
        return;
      }
      await Bun.sleep(pollMs);
      await check();
    };
    void check();
  });
}

function waitPidExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve) => {
    const check = () => {
      try {
        process.kill(pid, 0);
      } catch {
        resolve();
        return;
      }

      if (Date.now() >= deadline) {
        resolve();
        return;
      }

      setTimeout(check, 50);
    };

    check();
  });
}
