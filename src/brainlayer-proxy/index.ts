// BrainLayer reverse-proxy (Track B / L1).
//
// mcplayer sits in front of BrainBar so agents connect to ONE stable front
// socket instead of each binding the raw /tmp/brainbar.sock via socat. A front
// UDS server accepts agent connections; each front client is backed by a managed
// connection to the BrainBar upstream, with bytes relayed both ways.
//
// P0.2 = the transparent relay. P0.3 = the headline: the upstream RECONNECTS on
// failure WITHOUT tearing down the front connection, so a BrainBar restart no
// longer drops every agent at once (the reconnect storm). Client bytes are held
// while the upstream is (re)connecting and flushed in order on recovery, so a
// request issued during the down window still lands once BrainBar returns.
//
// The upstream target is transport-pluggable (unix today, tcp for the Track-C
// two-Mac hub) — the same proxy fronts BrainBar over either transport.

import net from "node:net";
import { rmSync } from "node:fs";
import { classify, encodeLine, NdjsonDecoder } from "../protocol";

export type UpstreamTarget =
  | { kind: "unix"; path: string }
  | { kind: "tcp"; host: string; port: number };

export interface BrainlayerProxyOptions {
  frontSocketPath: string;
  upstream: UpstreamTarget;
  /** Initial reconnect backoff (ms) after an upstream drop. Default 250. */
  reconnectDelayMs?: number;
  /** Backoff ceiling (ms). Default 2000. */
  maxReconnectDelayMs?: number;
  /** Upstream connect deadline (ms). Default 5000. */
  connectTimeoutMs?: number;
  /**
   * Per-request hang deadline (ms). If a front request id gets no upstream
   * response within this window, the proxy synthesizes a LOUD JSON-RPC error
   * carrying that id so the agent fails fast + visibly instead of hanging — the
   * connection stays open (NOT a socat -T inactivity kill). Default 15000.
   */
  requestTimeoutMs?: number;
  /**
   * Degraded deadline (ms). If a request is pending while the upstream is
   * unreachable for this long, the proxy answers that id with a LOUD "degraded —
   * upstream unreachable, retrying" JSON-RPC error (the connection stays open and
   * the upstream keeps reconnecting, so a later request auto-recovers). Default
   * 5000. Should be < requestTimeoutMs so a down upstream is reported faster than
   * a slow one. */
  degradedMs?: number;
}

export function connectUpstream(target: UpstreamTarget): net.Socket {
  return target.kind === "unix"
    ? net.createConnection({ path: target.path })
    : net.createConnection({ host: target.host, port: target.port });
}

function socketCanWrite(sock: net.Socket | undefined): sock is net.Socket {
  return Boolean(
    sock &&
    sock.writable &&
    !sock.destroyed &&
    !sock.readableEnded &&
    !sock.writableEnded &&
    !sock.writableNeedDrain,
  );
}

export class BrainlayerProxy {
  readonly #frontSocketPath: string;
  readonly #upstream: UpstreamTarget;
  readonly #reconnectDelayMs: number;
  readonly #maxReconnectDelayMs: number;
  readonly #connectTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  readonly #degradedMs: number;
  #server?: net.Server;
  #closed = false;
  readonly #sockets = new Set<net.Socket>();

  constructor(opts: BrainlayerProxyOptions) {
    this.#frontSocketPath = opts.frontSocketPath;
    this.#upstream = opts.upstream;
    this.#reconnectDelayMs = opts.reconnectDelayMs ?? 250;
    this.#maxReconnectDelayMs = opts.maxReconnectDelayMs ?? 2000;
    this.#connectTimeoutMs = opts.connectTimeoutMs ?? 5000;
    this.#requestTimeoutMs = opts.requestTimeoutMs ?? 15000;
    this.#degradedMs = opts.degradedMs ?? 5000;
  }

  get frontSocketPath(): string {
    return this.#frontSocketPath;
  }

  async start(): Promise<void> {
    this.#closed = false;
    rmSync(this.#frontSocketPath, { force: true });
    const server = net.createServer((client) => this.#handleClient(client));
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once("error", onError);
      server.listen(this.#frontSocketPath, () => {
        server.off("error", onError);
        resolve();
      });
    });
  }

  #handleClient(client: net.Socket): void {
    this.#sockets.add(client);

    const pending: Buffer[] = [];
    let upstream: net.Socket | undefined;
    let upstreamReady = false;
    let clientClosed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let delay = this.#reconnectDelayMs;
    let flushingPending = false;
    let generation = 0;

    // Frame-aware LOUD degradation. The front decoder spots each request id and
    // arms two deadlines; the upstream relay parses complete NDJSON frames so it
    // can settle matching responses and suppress a late real response after the
    // id was already answered by a synthesized LOUD error. Whichever fires first
    // answers that id with a LOUD JSON-RPC error (never a silent hang, never a
    // fake-empty result), and the connection stays open:
    //   • DEGRADED  — upstream still unreachable after degradedMs (BrainBar down)
    //   • TIMED OUT — upstream up but no response within requestTimeoutMs (slow query)
    const frontDecoder = new NdjsonDecoder();
    let upstreamFrameBuffer = Buffer.alloc(0);
    const answered = new Set<string>();
    const requestTimeoutMs = this.#requestTimeoutMs;
    const degradedMs = this.#degradedMs;
    const upstreamLabel =
      this.#upstream.kind === "unix"
        ? this.#upstream.path
        : `${this.#upstream.host}:${this.#upstream.port}`;
    const idKey = (id: unknown) => JSON.stringify(id);

    interface RequestDeadlines {
      hang?: ReturnType<typeof setTimeout>;
      degraded?: ReturnType<typeof setTimeout>;
    }
    const pendingRequests = new Map<string, RequestDeadlines>();

    const clearDeadlines = (key: string) => {
      const d = pendingRequests.get(key);
      if (!d) return;
      if (d.hang) clearTimeout(d.hang);
      if (d.degraded) clearTimeout(d.degraded);
      pendingRequests.delete(key);
    };

    // Answer a request id exactly once with a LOUD error, then never again
    // (settles the late real response too — see filterUpstreamChunk).
    const answerOnce = (
      key: string,
      id: unknown,
      code: number,
      message: string,
    ) => {
      if (answered.has(key)) return;
      answered.add(key);
      clearDeadlines(key);
      console.error(`BRAINLAYER_PROXY_LOUD id=${key} code=${code} ${message}`);
      if (!clientClosed)
        client.write(
          encodeLine({ jsonrpc: "2.0", id, error: { code, message } }),
        );
    };

    const settleRequest = (key: string) => {
      answered.add(key);
      clearDeadlines(key);
    };

    const trackClientFrames = (chunk: Buffer) => {
      for (const msg of frontDecoder.push(chunk)) {
        if (classify(msg) !== "request") continue;
        const id = (msg as { id: unknown }).id;
        const key = idKey(id);
        if (pendingRequests.has(key) || answered.has(key)) continue;
        const deadlines: RequestDeadlines = {
          hang: setTimeout(
            () =>
              answerOnce(
                key,
                id,
                -32000,
                `BrainLayer slow/unresponsive — request timed out after ${requestTimeoutMs}ms`,
              ),
            requestTimeoutMs,
          ),
          degraded: setTimeout(() => {
            // Only LOUD-degrade if the upstream is still unreachable; if it is up
            // the request is genuinely in flight and the hang timer covers it.
            if (upstreamReady) return;
            answerOnce(
              key,
              id,
              -32010,
              `BrainLayer degraded — upstream ${upstreamLabel} unreachable, retrying`,
            );
          }, degradedMs),
        };
        pendingRequests.set(key, deadlines);
      }
    };

    const filterUpstreamChunk = (chunk: Buffer): Buffer | undefined => {
      upstreamFrameBuffer =
        upstreamFrameBuffer.length === 0
          ? Buffer.from(chunk)
          : Buffer.concat([upstreamFrameBuffer, chunk]);

      const relayFrames: Buffer[] = [];
      let nl: number;
      while ((nl = upstreamFrameBuffer.indexOf(0x0a)) !== -1) {
        const line = upstreamFrameBuffer.subarray(0, nl);
        const frame = Buffer.concat([line, Buffer.from("\n")]);
        upstreamFrameBuffer = upstreamFrameBuffer.subarray(nl + 1);
        const text = line.toString("utf8").trim();
        if (!text) {
          relayFrames.push(frame);
          continue;
        }

        let msg: unknown;
        try {
          msg = JSON.parse(text);
        } catch {
          relayFrames.push(frame);
          continue;
        }

        if (classify(msg) === "response") {
          const key = idKey((msg as { id: unknown }).id);
          if (answered.has(key)) continue;
          settleRequest(key);
        }
        relayFrames.push(frame);
      }
      return relayFrames.length > 0 ? Buffer.concat(relayFrames) : undefined;
    };

    const handleWriteFailure = (target: net.Socket) => {
      upstreamReady = false;
      target.destroy();
      flushPending();
    };

    const flushPending = () => {
      if (flushingPending || !upstreamReady || !socketCanWrite(upstream))
        return;
      const target = upstream;
      const writeGeneration = generation;
      const isCurrent = () => generation === writeGeneration;
      const buf = pending[0];
      if (!buf) return;

      flushingPending = true;
      try {
        target.write(buf, (err) => {
          if (!isCurrent()) return;
          flushingPending = false;
          if (err || target.destroyed) {
            handleWriteFailure(target);
            return;
          }
          pending.shift();
          setImmediate(flushPending);
        });
      } catch {
        flushingPending = false;
        handleWriteFailure(target);
      }
    };

    const bufferForReconnect = (chunk: Buffer) => {
      pending.push(chunk);
      flushPending();
    };

    const connect = () => {
      if (clientClosed || this.#closed) return;
      const myGen = ++generation;
      const isCurrent = () => generation === myGen;
      const u = connectUpstream(this.#upstream);
      upstreamFrameBuffer = Buffer.alloc(0);
      upstream = u;
      upstreamReady = false;
      this.#sockets.add(u);
      let connectTimer: ReturnType<typeof setTimeout> | undefined;
      const clearConnectTimer = () => {
        if (!connectTimer) return;
        clearTimeout(connectTimer);
        connectTimer = undefined;
      };

      let goneHandled = false;
      const onGone = () => {
        if (!isCurrent()) return;
        if (goneHandled) return;
        goneHandled = true;
        clearConnectTimer();
        this.#sockets.delete(u);
        u.destroy();
        upstream = undefined;
        upstreamReady = false;
        flushingPending = false;
        // Reconnect WITHOUT tearing down the front connection (the storm fix).
        if (clientClosed || this.#closed) return;
        reconnectTimer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, this.#maxReconnectDelayMs);
      };

      connectTimer = setTimeout(() => {
        if (!isCurrent()) return;
        u.destroy();
      }, this.#connectTimeoutMs);

      u.on("connect", () => {
        if (!isCurrent()) return;
        clearConnectTimer();
        upstreamReady = true;
        delay = this.#reconnectDelayMs; // reset backoff on a good connect
        flushPending();
      });
      u.on("data", (chunk: Buffer) => {
        if (!isCurrent()) return;
        const relayChunk = filterUpstreamChunk(chunk);
        if (relayChunk && !clientClosed) client.write(relayChunk);
      });
      u.on("drain", () => {
        if (!isCurrent()) return;
        flushPending();
      });
      u.on("end", () => {
        if (!isCurrent()) return;
        upstreamReady = false;
      });
      u.on("close", onGone);
      u.on("error", onGone);
    };

    client.on("data", (chunk: Buffer) => {
      // Buffer until an upstream is connected (initial connect OR a reconnect),
      // then flush in order — a request sent while BrainBar is down still lands.
      bufferForReconnect(chunk);
      trackClientFrames(chunk);
    });

    const teardownClient = () => {
      if (clientClosed) return;
      clientClosed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      for (const key of [...pendingRequests.keys()]) clearDeadlines(key);
      this.#sockets.delete(client);
      client.destroy();
      if (upstream) {
        this.#sockets.delete(upstream);
        upstream.destroy();
      }
    };
    client.on("close", teardownClient);
    client.on("error", teardownClient);

    connect();
  }

  async shutdown(): Promise<void> {
    this.#closed = true;
    for (const sock of this.#sockets) sock.destroy();
    this.#sockets.clear();
    const server = this.#server;
    this.#server = undefined;
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(this.#frontSocketPath, { force: true });
  }
}
