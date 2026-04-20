import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { McpFrameReader, encodeMcpMessage } from "../../src/mcp-framing";

type JsonRpcMessage = Record<string, unknown>;

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const SERVICE_LABEL = "com.mcplayer.multiplexer";
const SERVICE_SOCKET_PATH = "/tmp/mcplayer.sock";
const REQUESTS_PER_CLIENT = 100;
const CLIENT_COUNT = 5;
const STRICT_SYSPOLICYD_CPU_LIMIT = 10;
const SERVICE_DOMAIN = `gui/${runCommand(["id", "-u"]).stdout.trim()}`;
const SERVICE_TARGET = `${SERVICE_DOMAIN}/${SERVICE_LABEL}`;
const ORIGINAL_PLIST_PATH = path.join(homedir(), "Library/LaunchAgents", `${SERVICE_LABEL}.plist`);

const state: {
  tempDir: string;
  configPath: string;
  plistPath: string;
  upstreamLogPath: string;
  syspolicydPid: string;
  originalServiceLoaded: boolean;
  originalSocketExisted: boolean;
} = {
  tempDir: mkdtempSync(path.join(tmpdir(), "mcplayer-load-test.")),
  configPath: "",
  plistPath: "",
  upstreamLogPath: "",
  syspolicydPid: "",
  originalServiceLoaded: false,
  originalSocketExisted: existsSync(SERVICE_SOCKET_PATH),
};

class BunMcpClient {
  readonly clientIndex: number;
  readonly socketPath: string;
  #socket: any;
  #reader = new McpFrameReader();
  #responses: JsonRpcMessage[] = [];
  #waiters: Array<() => void> = [];
  #drainWaiters: Array<() => void> = [];
  #errors: Error[] = [];
  #closed = false;

  constructor(clientIndex: number, socketPath: string) {
    this.clientIndex = clientIndex;
    this.socketPath = socketPath;
  }

  async connect(): Promise<void> {
    this.#socket = await Bun.connect({
      unix: this.socketPath,
      socket: {
        data: (_socket, chunk) => {
          const messages = this.#reader.push(Buffer.from(chunk));
          for (const message of messages) {
            this.#responses.push(message as JsonRpcMessage);
          }
          this.#wake();
        },
        drain: () => {
          this.#wakeDrain();
        },
        close: () => {
          this.#closed = true;
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

  async sendBatch(): Promise<void> {
    const frames: Uint8Array[] = [
      Buffer.from("TARGET:load-test\n", "utf8"),
      encodeMcpMessage({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: {
            name: `load-client-${this.clientIndex}`,
            version: "1.0.0",
          },
        },
      }),
      encodeMcpMessage({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    ];

    for (let sequence = 1; sequence <= REQUESTS_PER_CLIENT; sequence += 1) {
      frames.push(
      encodeMcpMessage({
        jsonrpc: "2.0",
        id: sequence,
        method: "tools/call",
        params: {
          name: "echo",
          arguments: {
            clientIndex: this.clientIndex,
            sequence,
          },
        },
      }),
      );
    }

    for (const frame of frames) {
      await this.#writeFrameFully(frame);
    }
  }

  async waitForResponses(expectedCount: number, timeoutMs: number): Promise<JsonRpcMessage[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.#responses.length < expectedCount) {
      if (this.#errors.length > 0) {
        throw this.#errors[0];
      }
      if (this.#closed && this.#responses.length < expectedCount) {
        throw new Error(
          `client ${this.clientIndex} closed early after ${this.#responses.length}/${expectedCount} responses`,
        );
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          `client ${this.clientIndex} timed out after ${timeoutMs}ms with ${this.#responses.length}/${expectedCount} responses`,
        );
      }
      await this.#waitForChange(remainingMs);
    }
    return [...this.#responses];
  }

  close(): void {
    if (this.#socket) {
      this.#socket.end();
    }
  }

  #waitForChange(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#waiters = this.#waiters.filter((waiter) => waiter !== onWake);
        reject(new Error(`timed out waiting for client ${this.clientIndex} activity`));
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
    for (const waiter of waiters) {
      waiter();
    }
  }

  async #writeFrameFully(frame: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < frame.length) {
      const written = this.#socket.write(frame.subarray(offset));
      if (written < 0) {
        throw new Error(`client ${this.clientIndex} write failed with ${written}`);
      }
      if (written === 0) {
        await this.#waitForDrain(5_000);
        continue;
      }
      offset += written;
    }
  }

  #waitForDrain(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#drainWaiters = this.#drainWaiters.filter((waiter) => waiter !== onDrain);
        reject(new Error(`client ${this.clientIndex} timed out waiting for socket drain`));
      }, timeoutMs);

      const onDrain = () => {
        clearTimeout(timeout);
        resolve();
      };

      this.#drainWaiters.push(onDrain);
    });
  }

  #wakeDrain(): void {
    const waiters = this.#drainWaiters.splice(0);
    for (const waiter of waiters) {
      waiter();
    }
  }
}

beforeAll(async () => {
  state.upstreamLogPath = path.join(state.tempDir, "mock-mcp-upstream.log");
  state.configPath = path.join(state.tempDir, "config.json");
  state.plistPath = path.join(state.tempDir, `${SERVICE_LABEL}.plist`);
  state.syspolicydPid = runCommand(["pgrep", "syspolicyd"]).stdout.trim();
  state.originalServiceLoaded = serviceIsLoaded();

  renderTestPlist();
  writeTestConfig();

  if (state.originalServiceLoaded) {
    bootoutService();
    await waitFor(() => !serviceIsLoaded(), 10_000, "launchctl bootout existing mcplayer daemon");
  }

  if (state.originalSocketExisted && existsSync(SERVICE_SOCKET_PATH)) {
    unlinkSync(SERVICE_SOCKET_PATH);
  }

  setLaunchctlEnv("MCPLAYER_CONFIG_PATH", state.configPath);
  setLaunchctlEnv("MCPLAYER_DISABLE_BRAINBAR_LOGS", "1");
  bootstrapService(state.plistPath);

  await waitFor(() => existsSync(SERVICE_SOCKET_PATH), 10_000, "mcplayer socket");
  await waitFor(serviceIsLoaded, 10_000, "launchctl service load");
});

afterAll(async () => {
  try {
    if (serviceIsLoaded()) {
      bootoutService();
      await waitFor(() => !existsSync(SERVICE_SOCKET_PATH), 10_000, "mcplayer socket cleanup");
    }
  } finally {
    unsetLaunchctlEnv("MCPLAYER_CONFIG_PATH");
    unsetLaunchctlEnv("MCPLAYER_DISABLE_BRAINBAR_LOGS");
    if (state.originalServiceLoaded && existsSync(ORIGINAL_PLIST_PATH)) {
      bootstrapService(ORIGINAL_PLIST_PATH);
      await waitFor(() => existsSync(SERVICE_SOCKET_PATH), 10_000, "restored mcplayer socket");
    }
    rmSync(state.tempDir, { recursive: true, force: true });
  }
});

test(
  "launchd daemon multiplexes 5 concurrent clients without drops, crashes, syspolicyd spikes, or orphaned MCP processes",
  async () => {
    const beforeService = launchctlPrint();
    expect(beforeService).toContain("state = running");

    const clients = await Promise.all(
      Array.from({ length: CLIENT_COUNT }, async (_, clientIndex) => {
        const client = new BunMcpClient(clientIndex, SERVICE_SOCKET_PATH);
        await client.connect();
        return client;
      }),
    );

    const beforeCpu = await sampleSyspolicydWindow(state.syspolicydPid, 10, 100);
    const syspolicydSampler = sampleSyspolicydCpu(state.syspolicydPid);
    try {
      await Promise.all(clients.map((client) => client.sendBatch()));
      const perClientResponses = await Promise.all(
        clients.map((client) => client.waitForResponses(REQUESTS_PER_CLIENT + 1, 20_000)),
      );

      const duringCpu = await syspolicydSampler.stop();
      const afterCpu = await sampleSyspolicydWindow(state.syspolicydPid, 10, 100);
      const afterService = launchctlPrint();
      expect(afterService).toContain("state = running");

      const upstreamEntries = readJsonLines(state.upstreamLogPath);
      const upstreamReceives = upstreamEntries.filter((entry) => entry.kind === "recv");
      const upstreamSends = upstreamEntries.filter((entry) => entry.kind === "send");

      expect(upstreamReceives).toHaveLength(CLIENT_COUNT * (REQUESTS_PER_CLIENT + 2));
      expect(
        upstreamReceives.filter((entry) => entry.payload.method === "tools/call"),
      ).toHaveLength(CLIENT_COUNT * REQUESTS_PER_CLIENT);
      expect(upstreamSends).toHaveLength(CLIENT_COUNT * (REQUESTS_PER_CLIENT + 1));

      const rewrittenToolCallIds = upstreamEntries
        .filter((entry) => entry.kind === "recv" && entry.payload.method === "tools/call")
        .map((entry) => String(entry.payload.id));
      expect(new Set(rewrittenToolCallIds).size).toBe(CLIENT_COUNT * REQUESTS_PER_CLIENT);
      for (const rewrittenId of rewrittenToolCallIds) {
        expect(rewrittenId).toContain(":::mcplayer:::");
      }

      const upstreamPids = new Set<number>();
      for (const [clientIndex, messages] of perClientResponses.entries()) {
        const initResponse = messages.find((message) => message.id === 0);
        expect(initResponse?.result).toBeTruthy();

        const callResponses = messages.filter((message) => typeof message.id === "number" && Number(message.id) > 0);
        expect(callResponses).toHaveLength(REQUESTS_PER_CLIENT);

        const ids = callResponses.map((message) => Number(message.id));
        expect(new Set(ids).size).toBe(REQUESTS_PER_CLIENT);
        expect(Math.min(...ids)).toBe(1);
        expect(Math.max(...ids)).toBe(REQUESTS_PER_CLIENT);

        for (const message of callResponses) {
          const sequence = Number(message.id);
          const structuredContent = (message.result as JsonRpcMessage).structuredContent as JsonRpcMessage;
          expect(structuredContent.clientIndex).toBe(clientIndex);
          expect(structuredContent.sequence).toBe(sequence);
          upstreamPids.add(Number(structuredContent.upstreamPid));
        }
      }

      expect(upstreamPids.size).toBe(1);
      const enforceStrictCpuGate =
        beforeCpu.maxCpu < STRICT_SYSPOLICYD_CPU_LIMIT ||
        process.env.MCPLAYER_LOAD_TEST_ENFORCE_CPU === "1";
      const cpuReport = {
        before: beforeCpu,
        during: duringCpu,
        after: afterCpu,
        strictLimit: STRICT_SYSPOLICYD_CPU_LIMIT,
        strictGateEnforced: enforceStrictCpuGate,
      };
      console.log(`mcplayer-load-test cpu-report ${JSON.stringify(cpuReport)}`);

      if (enforceStrictCpuGate) {
        expect(duringCpu.maxCpu).toBeLessThanOrEqual(STRICT_SYSPOLICYD_CPU_LIMIT);
      }

      for (const client of clients) {
        client.close();
      }

      bootoutService();
      await waitFor(() => !serviceIsLoaded(), 10_000, "launchctl service shutdown");
      await waitFor(() => !existsSync(SERVICE_SOCKET_PATH), 10_000, "socket shutdown");

      const orphansOutput = runCommand(["./bin/mcplayer", "orphans"], { cwd: REPO_ROOT }).stdout
        .trim()
        .split("\n");
      expect(orphansOutput).toEqual(["mcplayer orphans"]);

      bootstrapService(state.plistPath);
      await waitFor(() => existsSync(SERVICE_SOCKET_PATH), 10_000, "mcplayer socket restart");
      await waitFor(serviceIsLoaded, 10_000, "launchctl service restart");
    } finally {
      await syspolicydSampler.stop();
      for (const client of clients) {
        client.close();
      }
    }
  },
  60_000,
);

function renderTestPlist(): void {
  const templatePath = path.join(REPO_ROOT, "launchd", `${SERVICE_LABEL}.plist`);
  const rendered = readFileSync(templatePath, "utf8").replaceAll("{{USER_HOME}}", homedir());
  writeFileSync(state.plistPath, rendered, "utf8");
}

function writeTestConfig(): void {
  const bunPath = runCommand(["which", "bun"]).stdout.trim();
  const upstreamScript = path.join(REPO_ROOT, "tests", "integration", "mock-mcp-upstream.ts");
  writeFileSync(
    state.configPath,
    JSON.stringify(
      {
        socketPath: SERVICE_SOCKET_PATH,
        servers: {
          "load-test": {
            command: bunPath,
            args: [upstreamScript],
            env: {
              MCPLAYER_LOAD_TEST_UPSTREAM_LOG: state.upstreamLogPath,
            },
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

function runCommand(
  command: string[],
  options: { cwd?: string; allowFailure?: boolean } = {},
): { stdout: string; stderr: string; exitCode: number | null } {
  const result = spawnSync(command[0], command.slice(1), {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: "utf8",
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(
      `command failed: ${command.join(" ")}\nexit=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    );
  }
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status,
  };
}

function serviceIsLoaded(): boolean {
  return launchctlPrint({ allowFailure: true }).exitCode === 0;
}

function launchctlPrint(
  options: { allowFailure?: boolean } = {},
): string | { stdout: string; stderr: string; exitCode: number | null } {
  const result = runCommand(["launchctl", "print", SERVICE_TARGET], {
    allowFailure: options.allowFailure,
  });
  if (options.allowFailure) {
    return result;
  }
  return result.stdout;
}

function bootoutService(): void {
  runCommand(["launchctl", "bootout", SERVICE_TARGET], { allowFailure: true });
  if (existsSync(state.plistPath)) {
    runCommand(["launchctl", "bootout", SERVICE_DOMAIN, state.plistPath], { allowFailure: true });
  }
}

function bootstrapService(plistPath: string): void {
  runCommand(["launchctl", "bootstrap", SERVICE_DOMAIN, plistPath]);
}

function setLaunchctlEnv(name: string, value: string): void {
  runCommand(["launchctl", "setenv", name, value]);
}

function unsetLaunchctlEnv(name: string): void {
  runCommand(["launchctl", "unsetenv", name], { allowFailure: true });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${description}`);
}

function readJsonLines(filePath: string): Array<Record<string, any>> {
  const content = readFileSync(filePath, "utf8");
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>);
}

function sampleSyspolicydCpu(pid: string): {
  stop: () => Promise<CpuReport>;
} {
  let stopped = false;
  const samples: number[] = [];
  const loop = (async () => {
    while (!stopped) {
      const output = runCommand(["ps", "-p", pid, "-o", "%cpu="]).stdout.trim();
      if (output.length > 0) {
        samples.push(Number(output));
      }
      await Bun.sleep(100);
    }
  })();

  return {
    async stop() {
      stopped = true;
      await loop;
      return buildCpuReport(samples);
    },
  };
}

interface CpuReport {
  samples: number[];
  averageCpu: number;
  maxCpu: number;
}

async function sampleSyspolicydWindow(
  pid: string,
  sampleCount: number,
  intervalMs: number,
): Promise<CpuReport> {
  const samples: number[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const output = runCommand(["ps", "-p", pid, "-o", "%cpu="]).stdout.trim();
    if (output.length > 0) {
      samples.push(Number(output));
    }
    if (index < sampleCount - 1) {
      await Bun.sleep(intervalMs);
    }
  }
  return buildCpuReport(samples);
}

function buildCpuReport(samples: number[]): CpuReport {
  return {
    samples,
    averageCpu:
      samples.length === 0 ? 0 : Number((samples.reduce((sum, value) => sum + value, 0) / samples.length).toFixed(2)),
    maxCpu: samples.length === 0 ? 0 : Number(Math.max(...samples).toFixed(2)),
  };
}
