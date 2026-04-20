import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import type { McplayerConfig, ServerConfig } from "./config";
import { McplayerLogger } from "./logger";
import { McpFrameReader, encodeMcpMessage, sleep } from "./mcp-framing";

const ID_SEPARATOR = ":::mcplayer:::";
const STATUS_HEADER = "CONTROL:status";
const WRITE_RETRY_MS = 10;
const DEFAULT_SOCKET_WRITE_MAX_RETRIES = 100;

type BunSocket = any;
type JsonRpcId = string | number | null;
type ClientWriteTestMode = "none" | "fail-once" | "zero-always";

interface SocketWriteOptions {
  forceFailOnce?: boolean;
  forceZeroAlways?: boolean;
  forceZeroOnce?: boolean;
  maxRetries: number;
}

interface ClientConnection {
  id: string;
  socket: BunSocket;
  toolName?: string;
  headerBuffer: Buffer;
  headerParsed: boolean;
  frameReader: McpFrameReader;
  upstreamKey?: string;
  closed: boolean;
  testWriteMode: ClientWriteTestMode;
  testWriteModeConsumed: boolean;
  writes: Promise<void>;
  operations: Promise<void>;
}

interface PendingRequest {
  clientId: string;
  originalId: JsonRpcId;
}

interface UpstreamConnection {
  key: string;
  toolName: string;
  mode: "pool" | "sidecar";
  ownerClientId?: string;
  child: ChildProcessWithoutNullStreams;
  frameReader: McpFrameReader;
  clients: Set<string>;
  pending: Map<string, PendingRequest>;
  operations: Promise<void>;
}

function cloneMessage<T>(message: T): T {
  return JSON.parse(JSON.stringify(message)) as T;
}

export class McplayerBroker {
  #config: McplayerConfig;
  #logger: McplayerLogger;
  #server: any;
  #socketPath: string;
  #clients = new Map<BunSocket, ClientConnection>();
  #clientsById = new Map<string, ClientConnection>();
  #pooledUpstreams = new Map<string, UpstreamConnection>();
  #sidecars = new Map<string, UpstreamConnection>();
  #stopping = false;
  #forcedBackpressurePending =
    Bun.env.MCPLAYER_TEST_FORCE_SOCKET_WRITE_ZERO_ONCE === "1";
  #forcedFirstClientWriteFailPending =
    Bun.env.MCPLAYER_TEST_FORCE_FIRST_CLIENT_WRITE_FAIL_ONCE === "1";
  #forcedFirstClientWriteZeroAlwaysPending =
    Bun.env.MCPLAYER_TEST_FORCE_FIRST_CLIENT_WRITE_ZERO_ALWAYS === "1";
  #socketWriteMaxRetries = resolveSocketWriteMaxRetries();
  #processGroupId = this.#resolveProcessGroupId();

  constructor(config: McplayerConfig, logger: McplayerLogger) {
    this.#config = config;
    this.#logger = logger;
    this.#socketPath = config.socketPath;
  }

  get socketPath(): string {
    return this.#socketPath;
  }

  get processGroupId(): number {
    return this.#processGroupId;
  }

  async start(): Promise<void> {
    rmSync(this.#socketPath, { force: true });

    this.#server = Bun.listen({
      unix: this.#socketPath,
      socket: {
        open: (socket: BunSocket) => this.#handleClientOpen(socket),
        data: (socket: BunSocket, data: Uint8Array) => this.#handleClientData(socket, data),
        close: (socket: BunSocket) => this.#handleClientClose(socket),
        error: (socket: BunSocket, error: Error) => {
          const client = this.#clients.get(socket);
          this.#logger.error("client-socket-error", {
            clientId: client?.id,
            error: error.message,
          });
        },
      },
    });

    await this.#warmPools();

    this.#logger.info("daemon-ready", {
      socketPath: this.#socketPath,
      processGroupId: this.#processGroupId,
      pooledTools: Object.entries(this.#config.servers)
        .filter(([, server]) => !server.strictIsolation && !server.disabled)
        .map(([tool]) => tool),
    });
  }

  async shutdown(signal: string): Promise<void> {
    if (this.#stopping) {
      return;
    }
    this.#stopping = true;

    this.#logger.warn("daemon-shutdown", { signal, processGroupId: this.#processGroupId });

    try {
      this.#server?.stop(true);
    } catch (error) {
      this.#logger.warn("server-stop-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    rmSync(this.#socketPath, { force: true });

    for (const client of this.#clientsById.values()) {
      try {
        client.socket.end();
      } catch {
        // ignore cleanup errors
      }
    }

    if (this.#processGroupId === process.pid) {
      try {
        process.kill(-this.#processGroupId, "SIGKILL");
        return;
      } catch (error) {
        this.#logger.warn("pgid-reap-failed", {
          error: error instanceof Error ? error.message : String(error),
          processGroupId: this.#processGroupId,
        });
      }
    }

    this.#killAllChildren();
    process.exit(0);
  }

  #killAllChildren(): void {
    const seen = new Set<number>();
    const upstreams = [
      ...this.#pooledUpstreams.values(),
      ...this.#sidecars.values(),
    ];
    for (const upstream of upstreams) {
      const pid = upstream.child.pid;
      if (pid && !seen.has(pid)) {
        seen.add(pid);
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already dead
        }
      }
    }
  }

  async #warmPools(): Promise<void> {
    for (const [toolName, server] of Object.entries(this.#config.servers)) {
      if (server.disabled || server.strictIsolation || server.warm === false) {
        continue;
      }
      await this.#ensurePool(toolName);
    }
  }

  #handleClientOpen(socket: BunSocket): void {
    let testWriteMode: ClientWriteTestMode = "none";
    if (this.#forcedFirstClientWriteFailPending) {
      this.#forcedFirstClientWriteFailPending = false;
      testWriteMode = "fail-once";
    } else if (this.#forcedFirstClientWriteZeroAlwaysPending) {
      this.#forcedFirstClientWriteZeroAlwaysPending = false;
      testWriteMode = "zero-always";
    }

    const client: ClientConnection = {
      id: randomUUID(),
      socket,
      headerBuffer: Buffer.alloc(0),
      headerParsed: false,
      frameReader: new McpFrameReader(),
      closed: false,
      testWriteMode,
      testWriteModeConsumed: false,
      writes: Promise.resolve(),
      operations: Promise.resolve(),
    };
    this.#clients.set(socket, client);
    this.#clientsById.set(client.id, client);
    this.#logger.info("client-open", { clientId: client.id });
  }

  #handleClientClose(socket: BunSocket): void {
    const client = this.#clients.get(socket);
    if (!client) {
      return;
    }

    this.#detachClient(client, "socket-close");
  }

  #handleClientData(socket: BunSocket, data: Uint8Array): void {
    const client = this.#clients.get(socket);
    if (!client || client.closed) {
      return;
    }

    const chunk = Buffer.from(data);

    client.operations = client.operations
      .then(async () => {
        if (!client.headerParsed) {
          client.headerBuffer = Buffer.concat([client.headerBuffer, chunk]);
          const newlineIndex = client.headerBuffer.indexOf("\n");
          if (newlineIndex === -1) {
            return;
          }

          const header = client.headerBuffer.subarray(0, newlineIndex).toString("utf8").trim();
          const remainder = client.headerBuffer.subarray(newlineIndex + 1);
          client.headerParsed = true;
          client.headerBuffer = Buffer.alloc(0);

          if (header === STATUS_HEADER) {
            await this.#sendClientBytes(
              client,
              Buffer.from(`${JSON.stringify(this.statusSnapshot())}\n`, "utf8"),
            );
            client.socket.end();
            return;
          }

          if (!header.startsWith("TARGET:")) {
            await this.#sendClientMcpError(client, null, `invalid target header: ${header}`);
            client.socket.end();
            return;
          }

          client.toolName = header.slice("TARGET:".length);
          if (!this.#config.servers[client.toolName]) {
            await this.#sendClientMcpError(client, null, `unknown tool: ${client.toolName}`);
            client.socket.end();
            return;
          }

          this.#logger.info("client-target", {
            clientId: client.id,
            toolName: client.toolName,
            strictIsolation: this.#config.servers[client.toolName].strictIsolation,
          });

          if (remainder.length > 0) {
            await this.#handleClientFrames(client, remainder);
          }
          return;
        }

        await this.#handleClientFrames(client, chunk);
      })
      .catch((error) => {
        this.#logger.error("client-data-failed", {
          clientId: client.id,
          error: error instanceof Error ? error.message : String(error),
        });
        try {
          client.socket.end();
        } catch {
          // ignore cleanup errors
        }
      });
  }

  async #handleClientFrames(client: ClientConnection, chunk: Uint8Array): Promise<void> {
    const messages = client.frameReader.push(chunk);
    for (const message of messages) {
      await this.#forwardClientMessage(client, message as Record<string, unknown>);
    }
  }

  async #forwardClientMessage(
    client: ClientConnection,
    message: Record<string, unknown>,
  ): Promise<void> {
    const upstream = await this.#getUpstreamForClient(client);
    upstream.clients.add(client.id);

    const forwarded = cloneMessage(message);
    if (Object.prototype.hasOwnProperty.call(forwarded, "id")) {
      const originalId = (forwarded.id ?? null) as JsonRpcId;
      const rewrittenId = `${client.id}${ID_SEPARATOR}${String(originalId)}`;
      forwarded.id = rewrittenId;
      upstream.pending.set(rewrittenId, {
        clientId: client.id,
        originalId,
      });
    }

    await writeToChild(upstream.child, encodeMcpMessage(forwarded));
  }

  async #getUpstreamForClient(client: ClientConnection): Promise<UpstreamConnection> {
    const toolName = client.toolName;
    if (!toolName) {
      throw new Error("client target missing");
    }

    const server = this.#config.servers[toolName];
    if (server.strictIsolation) {
      if (!client.upstreamKey) {
        const upstream = this.#spawnUpstream(toolName, server, "sidecar", client.id);
        client.upstreamKey = upstream.key;
        this.#sidecars.set(upstream.key, upstream);
      }
      const upstream = this.#sidecars.get(client.upstreamKey);
      if (!upstream) {
        throw new Error(`missing sidecar for client ${client.id}`);
      }
      return upstream;
    }

    const upstream = await this.#ensurePool(toolName);
    client.upstreamKey = upstream.key;
    return upstream;
  }

  async #ensurePool(toolName: string): Promise<UpstreamConnection> {
    const existing = this.#pooledUpstreams.get(toolName);
    if (existing) {
      return existing;
    }

    const server = this.#config.servers[toolName];
    const upstream = this.#spawnUpstream(toolName, server, "pool");
    this.#pooledUpstreams.set(toolName, upstream);
    return upstream;
  }

  #spawnUpstream(
    toolName: string,
    server: ServerConfig,
    mode: "pool" | "sidecar",
    ownerClientId?: string,
  ): UpstreamConnection {
    const child = spawn(server.command, server.args, {
      cwd: server.cwd,
      env: {
        ...process.env,
        ...server.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const upstream: UpstreamConnection = {
      key: mode === "pool" ? toolName : `sidecar:${ownerClientId}`,
      toolName,
      mode,
      ownerClientId,
      child,
      frameReader: new McpFrameReader(),
      clients: new Set<string>(),
      pending: new Map<string, PendingRequest>(),
      operations: Promise.resolve(),
    };

    child.stdout.on("data", (chunk: Buffer) => {
      const copiedChunk = Buffer.from(chunk);
      upstream.operations = upstream.operations
        .then(() => this.#handleUpstreamData(upstream, copiedChunk))
        .catch((error) => {
          this.#logger.error("upstream-data-failed", {
            toolName,
            mode,
            pid: child.pid,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        this.#logger.debug("upstream-stderr", {
          toolName,
          mode,
          pid: child.pid,
          text,
        });
      }
    });
    child.on("exit", (code, signal) => {
      this.#logger.warn("upstream-exit", {
        toolName,
        mode,
        pid: child.pid,
        code,
        signal,
      });
      if (mode === "pool") {
        this.#pooledUpstreams.delete(toolName);
      } else {
        this.#sidecars.delete(upstream.key);
      }
    });
    child.on("error", (error) => {
      this.#logger.error("upstream-error", {
        toolName,
        mode,
        error: error.message,
      });
    });

    this.#logger.info("upstream-spawn", {
      toolName,
      mode,
      pid: child.pid,
      strictIsolation: server.strictIsolation,
    });

    return upstream;
  }

  async #handleUpstreamData(
    upstream: UpstreamConnection,
    chunk: Buffer,
  ): Promise<void> {
    const messages = upstream.frameReader.push(chunk);
    for (const message of messages) {
      await this.#routeUpstreamMessage(upstream, message as Record<string, unknown>);
    }
  }

  async #routeUpstreamMessage(
    upstream: UpstreamConnection,
    message: Record<string, unknown>,
  ): Promise<void> {
    const messageId = message.id;
    if (typeof messageId === "string" && upstream.pending.has(messageId)) {
      const pending = upstream.pending.get(messageId)!;
      upstream.pending.delete(messageId);

      const client = this.#clientsById.get(pending.clientId);
      if (!client || client.closed) {
        return;
      }

      const restored = cloneMessage(message);
      restored.id = pending.originalId;
      await this.#sendClientMessage(client, restored);
      return;
    }

    if (!Object.prototype.hasOwnProperty.call(message, "id") && typeof message.method === "string") {
      const targets =
        upstream.mode === "sidecar" && upstream.ownerClientId
          ? [upstream.ownerClientId]
          : [...upstream.clients];
      await Promise.all(
        targets.map(async (clientId) => {
          const client = this.#clientsById.get(clientId);
          if (!client || client.closed) {
            return;
          }
          await this.#sendClientMessage(client, message);
        }),
      );
      return;
    }

    this.#logger.warn("unroutable-upstream-message", {
      toolName: upstream.toolName,
      mode: upstream.mode,
      message,
    });
  }

  async #sendClientMessage(
    client: ClientConnection,
    message: Record<string, unknown>,
  ): Promise<void> {
    await this.#sendClientBytes(client, encodeMcpMessage(message));
  }

  async #sendClientMcpError(
    client: ClientConnection,
    id: JsonRpcId,
    errorMessage: string,
  ): Promise<void> {
    await this.#sendClientMessage(client, {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: errorMessage,
      },
    });
  }

  async #sendClientBytes(client: ClientConnection, payload: Uint8Array): Promise<void> {
    if (client.closed) {
      return;
    }

    client.writes = client.writes
      .catch(() => undefined)
      .then(async () => {
        if (client.closed) {
          return;
        }

        try {
          await safeSocketWrite(client.socket, payload, this.#logger, this.#socketWriteOptionsFor(client));
        } catch (error) {
          this.#handleClientWriteFailure(client, error);
        }
      });
    return client.writes;
  }

  #consumeForcedBackpressure(): boolean {
    if (!this.#forcedBackpressurePending) {
      return false;
    }
    this.#forcedBackpressurePending = false;
    return true;
  }

  #socketWriteOptionsFor(client: ClientConnection): SocketWriteOptions {
    const options: SocketWriteOptions = {
      forceZeroOnce: this.#consumeForcedBackpressure(),
      maxRetries: this.#socketWriteMaxRetries,
    };

    if (client.testWriteMode === "fail-once" && !client.testWriteModeConsumed) {
      client.testWriteModeConsumed = true;
      options.forceFailOnce = true;
    } else if (client.testWriteMode === "zero-always") {
      options.forceZeroAlways = true;
    }

    return options;
  }

  #handleClientWriteFailure(client: ClientConnection, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.#logger.warn("client-write-failed", {
      clientId: client.id,
      toolName: client.toolName,
      error: message,
    });
    this.#detachClient(client, "write-failed", { error: message });
    try {
      client.socket.end();
    } catch {
      // ignore cleanup errors
    }
  }

  #detachClient(
    client: ClientConnection,
    reason: string,
    extra: Record<string, unknown> = {},
  ): void {
    if (client.closed) {
      return;
    }

    client.closed = true;
    this.#clients.delete(client.socket);
    this.#clientsById.delete(client.id);

    if (client.upstreamKey) {
      const upstream =
        this.#pooledUpstreams.get(client.upstreamKey) ?? this.#sidecars.get(client.upstreamKey);
      if (upstream) {
        upstream.clients.delete(client.id);
        for (const [rewrittenId, pending] of upstream.pending.entries()) {
          if (pending.clientId === client.id) {
            upstream.pending.delete(rewrittenId);
          }
        }
        if (upstream.mode === "sidecar") {
          this.#sidecars.delete(upstream.key);
          upstream.child.kill("SIGKILL");
        }
      }
    }

    this.#logger.info("client-close", {
      clientId: client.id,
      toolName: client.toolName,
      reason,
      ...extra,
    });
  }

  statusSnapshot(): Record<string, unknown> {
    return {
      socketPath: this.#socketPath,
      processId: process.pid,
      processGroupId: this.#processGroupId,
      clientCount: this.#clientsById.size,
      configuredServers: Object.entries(this.#config.servers).map(([toolName, server]) => ({
        toolName,
        strictIsolation: server.strictIsolation,
        disabled: server.disabled,
        warm: server.warm,
      })),
      pools: [...this.#pooledUpstreams.values()].map((upstream) => ({
        toolName: upstream.toolName,
        pid: upstream.child.pid,
        clients: upstream.clients.size,
        pendingRequests: upstream.pending.size,
      })),
      sidecars: [...this.#sidecars.values()].map((upstream) => ({
        toolName: upstream.toolName,
        pid: upstream.child.pid,
        ownerClientId: upstream.ownerClientId,
        pendingRequests: upstream.pending.size,
      })),
    };
  }

  #resolveProcessGroupId(): number {
    try {
      const stdout = execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], {
        encoding: "utf8",
      });
      const parsed = Number(stdout.trim());
      return Number.isFinite(parsed) ? parsed : process.pid;
    } catch {
      return process.pid;
    }
  }
}

async function safeSocketWrite(
  socket: BunSocket,
  payload: Uint8Array,
  logger: McplayerLogger,
  options: SocketWriteOptions,
): Promise<void> {
  let offset = 0;
  let forceFailOnce = options.forceFailOnce ?? false;
  let forceZeroOnce = options.forceZeroOnce ?? false;
  const forceZeroAlways = options.forceZeroAlways ?? false;
  let zeroWriteRetries = 0;

  while (offset < payload.length) {
    let written = 0;
    if (forceFailOnce) {
      forceFailOnce = false;
      written = -1;
    } else if (forceZeroOnce || forceZeroAlways) {
      forceZeroOnce = false;
      written = 0;
    } else {
      written = socket.write(payload.subarray(offset));
    }

    if (written < 0) {
      throw new Error(`socket write failed: ${written}`);
    }

    if (written === 0) {
      zeroWriteRetries += 1;
      logger.info("socket-backpressure", {
        bytesRemaining: payload.length - offset,
        retries: zeroWriteRetries,
      });
      if (zeroWriteRetries >= options.maxRetries) {
        logger.warn("socket-backpressure-timeout", {
          bytesRemaining: payload.length - offset,
          retries: zeroWriteRetries,
        });
        throw new Error(`socket write exhausted retries after ${zeroWriteRetries} attempts`);
      }
      await sleep(WRITE_RETRY_MS);
      continue;
    }

    zeroWriteRetries = 0;
    offset += written;
  }
}

function resolveSocketWriteMaxRetries(): number {
  const raw = Bun.env.MCPLAYER_TEST_SOCKET_WRITE_MAX_RETRIES;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_SOCKET_WRITE_MAX_RETRIES;
}

async function writeToChild(
  child: ChildProcessWithoutNullStreams,
  payload: Uint8Array,
): Promise<void> {
  const stream = child.stdin;
  const buffer = Buffer.from(payload);
  const canWriteMore = stream.write(buffer);
  if (!canWriteMore) {
    await once(stream, "drain");
  }
}
