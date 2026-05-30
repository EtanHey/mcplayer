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
  #server?: net.Server;
  #closed = false;
  readonly #sockets = new Set<net.Socket>();

  constructor(opts: BrainlayerProxyOptions) {
    this.#frontSocketPath = opts.frontSocketPath;
    this.#upstream = opts.upstream;
    this.#reconnectDelayMs = opts.reconnectDelayMs ?? 250;
    this.#maxReconnectDelayMs = opts.maxReconnectDelayMs ?? 2000;
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

    const markUpstreamUnusable = (u: net.Socket) => {
      if (upstream === u) upstreamReady = false;
    };

    const handleWriteFailure = (
      target: net.Socket,
      chunk: Buffer,
      alreadyPending: boolean,
    ) => {
      if (upstream !== target) return;
      if (!alreadyPending) pending.unshift(chunk);
      markUpstreamUnusable(target);
      target.destroy();
    };

    const flushPending = () => {
      if (flushingPending || !socketCanWrite(upstream)) return;
      const target = upstream;
      const buf = pending[0];
      if (!buf) return;

      flushingPending = true;
      target.write(buf, (err) => {
        flushingPending = false;
        if (upstream !== target) return;
        if (err || target.destroyed) {
          handleWriteFailure(target, buf, true);
          return;
        }
        pending.shift();
        setImmediate(flushPending);
      });
    };

    const bufferForReconnect = (chunk: Buffer) => {
      pending.push(chunk);
      flushPending();
    };

    const writeToReadyUpstream = (chunk: Buffer) => {
      if (!upstreamReady || !socketCanWrite(upstream)) {
        bufferForReconnect(chunk);
        return;
      }

      const target = upstream;

      try {
        target.write(chunk, (err) => {
          if (err) handleWriteFailure(target, chunk, false);
        });
      } catch {
        handleWriteFailure(target, chunk, false);
      }
    };

    const connect = () => {
      if (clientClosed || this.#closed) return;
      const u = connectUpstream(this.#upstream);
      upstream = u;
      upstreamReady = false;
      this.#sockets.add(u);

      let goneHandled = false;
      const onGone = () => {
        if (goneHandled) return;
        goneHandled = true;
        this.#sockets.delete(u);
        u.destroy();
        if (upstream === u) {
          upstream = undefined;
          upstreamReady = false;
          flushingPending = false;
          // Reconnect WITHOUT tearing down the front connection (the storm fix).
          if (clientClosed || this.#closed) return;
          reconnectTimer = setTimeout(connect, delay);
          delay = Math.min(delay * 2, this.#maxReconnectDelayMs);
        }
      };

      u.on("connect", () => {
        if (upstream !== u) return;
        upstreamReady = true;
        delay = this.#reconnectDelayMs; // reset backoff on a good connect
        flushPending();
      });
      u.on("data", (chunk: Buffer) => {
        if (upstream !== u) return;
        if (!clientClosed) client.write(chunk);
      });
      u.on("drain", () => {
        if (upstream === u) flushPending();
      });
      u.on("end", () => markUpstreamUnusable(u));
      u.on("close", onGone);
      u.on("error", onGone);
    };

    client.on("data", (chunk: Buffer) => {
      // Buffer until an upstream is connected (initial connect OR a reconnect),
      // then flush in order — a request sent while BrainBar is down still lands.
      writeToReadyUpstream(chunk);
    });

    const teardownClient = () => {
      if (clientClosed) return;
      clientClosed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
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
