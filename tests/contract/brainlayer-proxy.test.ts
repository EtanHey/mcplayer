import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeLine, NdjsonDecoder } from "../../src/protocol";
import { BrainlayerProxy } from "../../src/brainlayer-proxy";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A minimal newline-delimited JSON-RPC server standing in for BrainBar on a
// unix socket. Echoes a canned result for any request, tagged so the test can
// tell which upstream instance answered (to prove reconnect later).
function startFakeBrainbar(socketPath: string, instance: string) {
  const server = net.createServer((sock) => {
    const decoder = new NdjsonDecoder();
    sock.on("data", (chunk) => {
      for (const msg of decoder.push(chunk) as Array<Record<string, unknown>>) {
        if (msg.method === undefined) continue;
        sock.write(
          encodeLine({
            jsonrpc: "2.0",
            id: msg.id,
            result: { ok: true, instance, echoedMethod: msg.method },
          }),
        );
      }
    });
  });
  return new Promise<net.Server>((resolve) => {
    server.listen(socketPath, () => resolve(server));
  });
}

function startFakeBrainbarTcp(instance: string, port = 0) {
  const server = net.createServer((sock) => {
    const decoder = new NdjsonDecoder();
    sock.on("data", (chunk) => {
      for (const msg of decoder.push(chunk) as Array<Record<string, unknown>>) {
        if (msg.method === undefined) continue;
        sock.write(
          encodeLine({
            jsonrpc: "2.0",
            id: msg.id,
            result: { ok: true, instance, echoedMethod: msg.method },
          }),
        );
      }
    });
  });
  return new Promise<{ port: number; server: net.Server }>((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object")
        resolve({ port: address.port, server });
    });
  });
}

function startCountingFakeBrainbarTcp(instance: string, port = 0) {
  let connections = 0;
  const connectionInstances: string[] = [];
  const server = net.createServer((sock) => {
    connections++;
    connectionInstances.push(instance);
    const decoder = new NdjsonDecoder();
    sock.on("data", (chunk) => {
      for (const msg of decoder.push(chunk) as Array<Record<string, unknown>>) {
        if (msg.method === undefined) continue;
        sock.write(
          encodeLine({
            jsonrpc: "2.0",
            id: msg.id,
            result: { ok: true, instance, echoedMethod: msg.method },
          }),
        );
      }
    });
  });
  return new Promise<{
    port: number;
    server: net.Server;
    connections: () => number;
    connectionInstances: () => string[];
  }>((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object")
        resolve({
          port: address.port,
          server,
          connections: () => connections,
          connectionInstances: () => [...connectionInstances],
        });
    });
  });
}

async function getFreeTcpPort() {
  const { port, server } = await startFakeBrainbarTcp("port-probe");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}


// Killable variant: tracks live server-side sockets so a "restart" can drop
// existing connections (a real BrainBar process death severs them, unlike a bare
// server.close() which only stops accepting).
function startKillableBrainbar(socketPath: string, instance: string) {
  const live = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    live.add(sock);
    sock.on("close", () => live.delete(sock));
    const decoder = new NdjsonDecoder();
    sock.on("data", (chunk) => {
      for (const msg of decoder.push(chunk) as Array<Record<string, unknown>>) {
        if (msg.method === undefined) continue;
        sock.write(
          encodeLine({
            jsonrpc: "2.0",
            id: msg.id,
            result: { ok: true, instance, echoedMethod: msg.method },
          }),
        );
      }
    });
  });
  return new Promise<{ kill: () => Promise<void> }>((resolve) => {
    server.listen(socketPath, () =>
      resolve({
        kill: () =>
          new Promise<void>((res) => {
            for (const s of live) s.destroy();
            live.clear();
            server.close(() => res());
          }),
      }),
    );
  });
}

function connectClient(socketPath: string) {
  const sock = net.createConnection(socketPath);
  const decoder = new NdjsonDecoder();
  const inbox: Array<Record<string, unknown>> = [];
  const waiters: Array<(m: Record<string, unknown>) => void> = [];
  sock.on("data", (chunk) => {
    for (const msg of decoder.push(chunk) as Array<Record<string, unknown>>) {
      const w = waiters.shift();
      if (w) w(msg);
      else inbox.push(msg);
    }
  });
  return {
    sock,
    ready: new Promise<void>((res, rej) => {
      sock.once("connect", res);
      sock.once("error", rej);
    }),
    request(method: string, id: number) {
      sock.write(encodeLine({ jsonrpc: "2.0", id, method, params: {} }));
      const existing = inbox.shift();
      if (existing) return Promise.resolve(existing);
      return new Promise<Record<string, unknown>>((res, rej) => {
        waiters.push(res);
        setTimeout(() => rej(new Error(`timeout waiting for ${method}`)), 2000);
      });
    },
    close: () => sock.destroy(),
  };
}

function connectOrderedClient(socketPath: string) {
  const sock = net.createConnection(socketPath);
  const decoder = new NdjsonDecoder();
  const pendingById = new Map<
    number,
    { resolve: (m: Record<string, unknown>) => void; reject: (e: Error) => void }
  >();
  sock.on("data", (chunk) => {
    for (const msg of decoder.push(chunk) as Array<Record<string, unknown>>) {
      const id = Number(msg.id);
      const pending = pendingById.get(id);
      if (!pending) continue;
      pendingById.delete(id);
      pending.resolve(msg);
    }
  });
  return {
    sock,
    ready: new Promise<void>((res, rej) => {
      sock.once("connect", res);
      sock.once("error", rej);
    }),
    request(method: string, id: number, timeoutMs = 2000) {
      sock.write(encodeLine({ jsonrpc: "2.0", id, method, params: {} }));
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timeout waiting for ${method}:${id}`)),
          timeoutMs,
        );
        pendingById.set(id, {
          resolve: (msg) => {
            clearTimeout(timer);
            resolve(msg);
          },
          reject,
        });
      });
    },
    close: () => sock.destroy(),
  };
}

describe("BrainlayerProxy — P0.2 transparent relay core", () => {
  test("relays a JSON-RPC request through to the upstream and back", async () => {
    const root = mkdtempSync(join(tmpdir(), "blp-"));
    const upstreamPath = join(root, "upstream.sock");
    const frontPath = join(root, "front.sock");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));

    const upstream = await startFakeBrainbar(upstreamPath, "A");
    cleanups.push(() => new Promise<void>((r) => upstream.close(() => r())));

    const proxy = new BrainlayerProxy({
      frontSocketPath: frontPath,
      upstream: { kind: "unix", path: upstreamPath },
    });
    await proxy.start();
    cleanups.push(() => proxy.shutdown());
    expect(proxy.frontSocketPath).toBe(frontPath);

    const client = connectClient(frontPath);
    cleanups.push(() => client.close());
    await client.ready;

    const res = await client.request("brain_search", 1);
    expect(res.id).toBe(1);
    expect((res.result as { ok?: boolean }).ok).toBe(true);
    expect((res.result as { instance?: string }).instance).toBe("A");
    expect((res.result as { echoedMethod?: string }).echoedMethod).toBe(
      "brain_search",
    );
  });

  test("two concurrent clients each get correctly-routed responses", async () => {
    const root = mkdtempSync(join(tmpdir(), "blp-"));
    const upstreamPath = join(root, "upstream.sock");
    const frontPath = join(root, "front.sock");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));

    const upstream = await startFakeBrainbar(upstreamPath, "A");
    cleanups.push(() => new Promise<void>((r) => upstream.close(() => r())));

    const proxy = new BrainlayerProxy({
      frontSocketPath: frontPath,
      upstream: { kind: "unix", path: upstreamPath },
    });
    await proxy.start();
    cleanups.push(() => proxy.shutdown());

    const c1 = connectClient(frontPath);
    const c2 = connectClient(frontPath);
    cleanups.push(() => c1.close());
    cleanups.push(() => c2.close());
    await Promise.all([c1.ready, c2.ready]);

    const [r1, r2] = await Promise.all([
      c1.request("brain_store", 11),
      c2.request("brain_recall", 22),
    ]);
    expect(r1.id).toBe(11);
    expect((r1.result as { echoedMethod?: string }).echoedMethod).toBe(
      "brain_store",
    );
    expect(r2.id).toBe(22);
    expect((r2.result as { echoedMethod?: string }).echoedMethod).toBe(
      "brain_recall",
    );
  });
});

describe("BrainlayerProxy — P0.3 reconnect-survival (the headline)", () => {
  test("front connection survives an upstream restart and reconnects to the new instance", async () => {
    const root = mkdtempSync(join(tmpdir(), "blp-rc-"));
    const upstreamPath = join(root, "upstream.sock");
    const frontPath = join(root, "front.sock");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));

    // BrainBar instance "A" comes up first.
    let bb = await startKillableBrainbar(upstreamPath, "A");

    const proxy = new BrainlayerProxy({
      frontSocketPath: frontPath,
      upstream: { kind: "unix", path: upstreamPath },
      reconnectDelayMs: 20,
    });
    await proxy.start();
    cleanups.push(() => proxy.shutdown());

    const client = connectClient(frontPath);
    cleanups.push(() => client.close());
    await client.ready;

    // Works against A.
    const r1 = await client.request("brain_search", 1);
    expect((r1.result as { instance?: string }).instance).toBe("A");

    // KILL BrainBar A (process death severs the proxy's upstream connection).
    await bb.kill();
    expect(client.sock.destroyed).toBe(false); // front connection MUST survive

    // Restart BrainBar as instance "B" on the SAME socket path.
    bb = await startKillableBrainbar(upstreamPath, "B");

    // The SAME client (never reconnected) issues its next call — the proxy must
    // have reconnected the upstream once, and the call must succeed against B.
    let r2: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 40 && !r2; attempt++) {
      try {
        r2 = await client.request("brain_search", 2);
      } catch {
        await sleep(25); // upstream still reconnecting; the next call lands
      }
    }
    expect(r2).toBeDefined();
    expect((r2!.result as { ok?: boolean }).ok).toBe(true);
    expect((r2!.result as { instance?: string }).instance).toBe("B");
    expect(client.sock.destroyed).toBe(false);
  });

  test("keeps queued client data when an upstream write fails during pending flush", async () => {
    const root = mkdtempSync(join(tmpdir(), "blp-flush-"));
    const frontPath = join(root, "front.sock");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));

    const upstreamPort = await getFreeTcpPort();

    const originalWrite = net.Socket.prototype.write as (...a: any[]) => boolean;
    let failedOnce = false;
    net.Socket.prototype.write = function (
      this: net.Socket,
      chunk: string | Uint8Array,
      ...args: any[]
    ) {
      const text = Buffer.isBuffer(chunk)
        ? chunk.toString("utf8")
        : String(chunk);
      if (
        !failedOnce &&
        (this.remotePort === upstreamPort || this.remoteAddress === "127.0.0.1") &&
        text.includes("brain_store")
      ) {
        failedOnce = true;
        const callback = args.find(
          (arg) => typeof arg === "function",
        ) as ((err?: Error) => void) | undefined;
        if (callback)
          setImmediate(() => {
            callback(new Error("write failed"));
            this.destroy();
          });
        else this.destroy();
        return true;
      }
      return originalWrite.call(this, chunk, ...args);
    } as typeof net.Socket.prototype.write;
    cleanups.push(() => {
      net.Socket.prototype.write = originalWrite as typeof net.Socket.prototype.write;
    });

    const proxy = new BrainlayerProxy({
      frontSocketPath: frontPath,
      upstream: { kind: "tcp", host: "127.0.0.1", port: upstreamPort },
      reconnectDelayMs: 20,
    });
    await proxy.start();
    cleanups.push(() => proxy.shutdown());

    const client = connectClient(frontPath);
    cleanups.push(() => client.close());
    await client.ready;

    const request = client.request("brain_store", 2);

    const upstream = await startFakeBrainbarTcp("A", upstreamPort);
    cleanups.push(
      () => {
        upstream.server.close();
      },
    );

    const res = await request;
    expect(res.id).toBe(2);
    expect((res.result as { instance?: string }).instance).toBe("A");
    expect((res.result as { echoedMethod?: string }).echoedMethod).toBe(
      "brain_store",
    );
    expect(failedOnce).toBe(true);
  });

  test("keeps queued client data when an upstream write fails after ready", async () => {
    const root = mkdtempSync(join(tmpdir(), "blp-ended-"));
    const frontPath = join(root, "front.sock");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));

    const upstream = await startFakeBrainbarTcp("A");
    cleanups.push(() => {
      upstream.server.close();
    });

    const originalWrite = net.Socket.prototype.write as (...a: any[]) => boolean;
    let failedOnce = false;
    net.Socket.prototype.write = function (
      this: net.Socket,
      chunk: string | Uint8Array,
      ...args: any[]
    ) {
      const text = Buffer.isBuffer(chunk)
        ? chunk.toString("utf8")
        : String(chunk);
      if (
        !failedOnce &&
        (this.remotePort === upstream.port || this.remoteAddress === "127.0.0.1") &&
        text.includes("brain_search")
      ) {
        failedOnce = true;
        const callback = args.find(
          (arg) => typeof arg === "function",
        ) as ((err?: Error) => void) | undefined;
        if (callback)
          setImmediate(() => {
            callback(new Error("write failed"));
            this.destroy();
          });
        else this.destroy();
        return true;
      }
      return originalWrite.call(this, chunk, ...args);
    } as typeof net.Socket.prototype.write;
    cleanups.push(() => {
      net.Socket.prototype.write = originalWrite as typeof net.Socket.prototype.write;
    });

    const proxy = new BrainlayerProxy({
      frontSocketPath: frontPath,
      upstream: { kind: "tcp", host: "127.0.0.1", port: upstream.port },
      reconnectDelayMs: 20,
    });
    await proxy.start();
    cleanups.push(() => proxy.shutdown());

    const client = connectClient(frontPath);
    cleanups.push(() => client.close());
    await client.ready;

    const warmup = await client.request("brain_recall", 98);
    expect(warmup.id).toBe(98);

    const res = await client.request("brain_search", 99);
    expect(res.id).toBe(99);
    expect((res.result as { instance?: string }).instance).toBe("A");
    expect(failedOnce).toBe(true);
  });

  test("does not reconnect when upstream write returns false for backpressure", async () => {
    const root = mkdtempSync(join(tmpdir(), "blp-backpressure-"));
    const frontPath = join(root, "front.sock");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));

    const upstream = await startCountingFakeBrainbarTcp("A");
    cleanups.push(() => {
      upstream.server.close();
    });

    const originalWrite = net.Socket.prototype.write as (...a: any[]) => boolean;
    let backpressuredOnce = false;
    net.Socket.prototype.write = function (
      this: net.Socket,
      chunk: string | Uint8Array,
      ...args: any[]
    ) {
      const text = Buffer.isBuffer(chunk)
        ? chunk.toString("utf8")
        : String(chunk);
      if (
        !backpressuredOnce &&
        (this.remotePort === upstream.port || this.remoteAddress === "127.0.0.1") &&
        text.includes("brain_search")
      ) {
        backpressuredOnce = true;
        originalWrite.call(this, chunk, ...args);
        return false;
      }
      return originalWrite.call(this, chunk, ...args);
    } as typeof net.Socket.prototype.write;
    cleanups.push(() => {
      net.Socket.prototype.write = originalWrite as typeof net.Socket.prototype.write;
    });

    const proxy = new BrainlayerProxy({
      frontSocketPath: frontPath,
      upstream: { kind: "tcp", host: "127.0.0.1", port: upstream.port },
      reconnectDelayMs: 20,
    });
    await proxy.start();
    cleanups.push(() => proxy.shutdown());

    const client = connectClient(frontPath);
    cleanups.push(() => client.close());
    await client.ready;

    const res = await client.request("brain_search", 100);
    await sleep(80);

    expect(res.id).toBe(100);
    expect((res.result as { instance?: string }).instance).toBe("A");
    expect(backpressuredOnce).toBe(true);
    expect(upstream.connections()).toBe(1);
  });

  test("preserves byte FIFO when fresh client data arrives during pending flush reconnect", async () => {
    const root = mkdtempSync(join(tmpdir(), "blp-byte-order-"));
    const frontPath = join(root, "front.sock");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));

    const upstreamPort = await getFreeTcpPort();
    const receivedIds: number[] = [];
    let connections = 0;
    const upstream = net.createServer((sock) => {
      connections++;
      const decoder = new NdjsonDecoder();
      sock.on("data", (chunk) => {
        for (const msg of decoder.push(chunk) as Array<Record<string, unknown>>) {
          if (msg.method === undefined) continue;
          receivedIds.push(Number(msg.id));
          sock.write(
            encodeLine({
              jsonrpc: "2.0",
              id: msg.id,
              result: { ok: true, instance: "A", echoedMethod: msg.method },
            }),
          );
        }
      });
    });
    cleanups.push(() => {
      upstream.close();
    });

    const originalWrite = net.Socket.prototype.write as (...a: any[]) => boolean;
    let heldCallback: ((err?: Error) => void) | undefined;
    let heldSocket: net.Socket | undefined;
    let heldOnce = false;
    net.Socket.prototype.write = function (
      this: net.Socket,
      chunk: string | Uint8Array,
      ...args: any[]
    ) {
      if (!heldOnce && this.remotePort === upstreamPort) {
        heldOnce = true;
        heldSocket = this;
        heldCallback = args.find(
          (arg) => typeof arg === "function",
        ) as ((err?: Error) => void) | undefined;
        return true;
      }
      return originalWrite.call(this, chunk, ...args);
    } as typeof net.Socket.prototype.write;
    cleanups.push(() => {
      net.Socket.prototype.write = originalWrite as typeof net.Socket.prototype.write;
    });

    const proxy = new BrainlayerProxy({
      frontSocketPath: frontPath,
      upstream: { kind: "tcp", host: "127.0.0.1", port: upstreamPort },
      reconnectDelayMs: 20,
    });
    await proxy.start();
    cleanups.push(() => proxy.shutdown());

    const client = net.createConnection(frontPath);
    client.on("data", () => {});
    cleanups.push(() => client.destroy());
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", reject);
    });

    const splitFrame = Buffer.from(
      encodeLine({
        jsonrpc: "2.0",
        id: 401,
        method: "brain_split",
        params: { value: "first" },
      }),
    );
    const splitAt = Math.floor(splitFrame.length / 2);
    client.write(splitFrame.subarray(0, splitAt));
    client.write(splitFrame.subarray(splitAt));

    await new Promise<void>((resolve) =>
      upstream.listen(upstreamPort, "127.0.0.1", () => resolve()),
    );
    for (let i = 0; i < 80 && !heldOnce; i++) await sleep(10);
    expect(heldOnce).toBe(true);

    client.write(
      encodeLine({
        jsonrpc: "2.0",
        id: 402,
        method: "brain_after",
        params: { value: "second" },
      }),
    );
    await sleep(80);

    heldSocket?.destroy();
    heldCallback?.(new Error("first flush failed after later bytes arrived"));

    for (let i = 0; i < 100 && receivedIds.length < 2; i++) await sleep(10);
    expect(receivedIds).toEqual([401, 402]);
    expect(connections).toBe(2);
  });

  test("ignores stale pending-flush callbacks after reconnect", async () => {
    const root = mkdtempSync(join(tmpdir(), "blp-stale-flush-"));
    const frontPath = join(root, "front.sock");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));

    const upstreamPort = await getFreeTcpPort();

    const originalWrite = net.Socket.prototype.write as (...a: any[]) => boolean;
    let heldCallback: ((err?: Error) => void) | undefined;
    let heldOnce = false;
    net.Socket.prototype.write = function (
      this: net.Socket,
      chunk: string | Uint8Array,
      ...args: any[]
    ) {
      const text = Buffer.isBuffer(chunk)
        ? chunk.toString("utf8")
        : String(chunk);
      if (
        !heldOnce &&
        (this.remotePort === upstreamPort || this.remoteAddress === "127.0.0.1") &&
        text.includes("brain_store")
      ) {
        heldOnce = true;
        heldCallback = args.find(
          (arg) => typeof arg === "function",
        ) as ((err?: Error) => void) | undefined;
        this.destroy();
        return true;
      }
      return originalWrite.call(this, chunk, ...args);
    } as typeof net.Socket.prototype.write;
    cleanups.push(() => {
      net.Socket.prototype.write = originalWrite as typeof net.Socket.prototype.write;
    });

    const proxy = new BrainlayerProxy({
      frontSocketPath: frontPath,
      upstream: { kind: "tcp", host: "127.0.0.1", port: upstreamPort },
      reconnectDelayMs: 20,
    });
    await proxy.start();
    cleanups.push(() => proxy.shutdown());

    const client = connectClient(frontPath);
    cleanups.push(() => client.close());
    await client.ready;

    const request = client.request("brain_store", 101);
    const upstream = await startCountingFakeBrainbarTcp("A", upstreamPort);
    cleanups.push(() => {
      upstream.server.close();
    });
    for (let i = 0; i < 50 && upstream.connections() < 2; i++) await sleep(10);
    expect(upstream.connections()).toBe(2);

    heldCallback?.();

    const res = await request;
    await sleep(50);

    expect(res.id).toBe(101);
    expect((res.result as { instance?: string }).instance).toBe("A");
    expect(heldOnce).toBe(true);
    expect(upstream.connections()).toBe(2);
  });

  test("flush write errors destroy the upstream and reconnect buffered data", async () => {
    const root = mkdtempSync(join(tmpdir(), "blp-flush-reconnect-"));
    const frontPath = join(root, "front.sock");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));

    const upstreamPort = await getFreeTcpPort();

    const originalWrite = net.Socket.prototype.write as (...a: any[]) => boolean;
    let failedOnce = false;
    net.Socket.prototype.write = function (
      this: net.Socket,
      chunk: string | Uint8Array,
      ...args: any[]
    ) {
      const text = Buffer.isBuffer(chunk)
        ? chunk.toString("utf8")
        : String(chunk);
      if (
        !failedOnce &&
        (this.remotePort === upstreamPort || this.remoteAddress === "127.0.0.1") &&
        text.includes("brain_recall")
      ) {
        failedOnce = true;
        const callback = args.find(
          (arg) => typeof arg === "function",
        ) as ((err?: Error) => void) | undefined;
        if (callback) setImmediate(() => callback(new Error("flush failed")));
        return true;
      }
      return originalWrite.call(this, chunk, ...args);
    } as typeof net.Socket.prototype.write;
    cleanups.push(() => {
      net.Socket.prototype.write = originalWrite as typeof net.Socket.prototype.write;
    });

    const proxy = new BrainlayerProxy({
      frontSocketPath: frontPath,
      upstream: { kind: "tcp", host: "127.0.0.1", port: upstreamPort },
      reconnectDelayMs: 20,
    });
    await proxy.start();
    cleanups.push(() => proxy.shutdown());

    const client = connectClient(frontPath);
    cleanups.push(() => client.close());
    await client.ready;

    const request = client.request("brain_recall", 102);
    const upstream = await startCountingFakeBrainbarTcp("A", upstreamPort);
    cleanups.push(() => {
      upstream.server.close();
    });
    const res = await request;

    expect(res.id).toBe(102);
    expect((res.result as { instance?: string }).instance).toBe("A");
    expect(failedOnce).toBe(true);
    expect(upstream.connections()).toBe(2);
  });

  test("rapid reconnect churn does not lose data, mis-order responses, or inflate reconnects", async () => {
    const root = mkdtempSync(join(tmpdir(), "blp-churn-"));
    const frontPath = join(root, "front.sock");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));

    const upstreamPort = await getFreeTcpPort();

    const originalWrite = net.Socket.prototype.write as (...a: any[]) => boolean;
    let heldCallback: ((err?: Error) => void) | undefined;
    let heldOnce = false;
    net.Socket.prototype.write = function (
      this: net.Socket,
      chunk: string | Uint8Array,
      ...args: any[]
    ) {
      const text = Buffer.isBuffer(chunk)
        ? chunk.toString("utf8")
        : String(chunk);
      if (
        !heldOnce &&
        (this.remotePort === upstreamPort || this.remoteAddress === "127.0.0.1") &&
        text.includes('"id":201')
      ) {
        heldOnce = true;
        heldCallback = args.find(
          (arg) => typeof arg === "function",
        ) as ((err?: Error) => void) | undefined;
        this.destroy();
        return true;
      }
      return originalWrite.call(this, chunk, ...args);
    } as typeof net.Socket.prototype.write;
    cleanups.push(() => {
      net.Socket.prototype.write = originalWrite as typeof net.Socket.prototype.write;
    });

    const proxy = new BrainlayerProxy({
      frontSocketPath: frontPath,
      upstream: { kind: "tcp", host: "127.0.0.1", port: upstreamPort },
      reconnectDelayMs: 20,
    });
    await proxy.start();
    cleanups.push(() => proxy.shutdown());

    const client = connectOrderedClient(frontPath);
    cleanups.push(() => client.close());
    await client.ready;

    const requests = [
      client.request("brain_store", 201),
      client.request("brain_search", 202),
      client.request("brain_recall", 203),
    ];
    const upstream = await startCountingFakeBrainbarTcp("A", upstreamPort);
    cleanups.push(() => {
      upstream.server.close();
    });

    for (let i = 0; i < 100 && upstream.connections() < 2; i++) await sleep(10);
    expect(upstream.connections()).toBe(2);

    heldCallback?.();

    const responses = await Promise.all(requests);
    await sleep(80);

    expect(responses.map((r) => r.id)).toEqual([201, 202, 203]);
    expect(responses.map((r) => (r.result as { instance?: string }).instance))
      .toEqual(["A", "A", "A"]);
    expect(heldOnce).toBe(true);
    expect(upstream.connections()).toBe(2);

    const after = await client.request("brain_entity", 204);
    expect(after.id).toBe(204);
    expect((after.result as { instance?: string }).instance).toBe("A");
    expect(upstream.connections()).toBe(2);
  });

  test("keeps queued write errors that arrive after socket supersession", async () => {
    const root = mkdtempSync(join(tmpdir(), "blp-stale-direct-"));
    const frontPath = join(root, "front.sock");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));

    const upstream = await startCountingFakeBrainbarTcp("A");
    cleanups.push(() => {
      upstream.server.close();
    });

    const originalWrite = net.Socket.prototype.write as (...a: any[]) => boolean;
    let heldCallback: ((err?: Error) => void) | undefined;
    let heldOnce = false;
    net.Socket.prototype.write = function (
      this: net.Socket,
      chunk: string | Uint8Array,
      ...args: any[]
    ) {
      const text = Buffer.isBuffer(chunk)
        ? chunk.toString("utf8")
        : String(chunk);
      if (
        !heldOnce &&
        (this.remotePort === upstream.port || this.remoteAddress === "127.0.0.1") &&
        text.includes('"id":302')
      ) {
        heldOnce = true;
        heldCallback = args.find(
          (arg) => typeof arg === "function",
        ) as ((err?: Error) => void) | undefined;
        this.destroy();
        return true;
      }
      return originalWrite.call(this, chunk, ...args);
    } as typeof net.Socket.prototype.write;
    cleanups.push(() => {
      net.Socket.prototype.write = originalWrite as typeof net.Socket.prototype.write;
    });

    const proxy = new BrainlayerProxy({
      frontSocketPath: frontPath,
      upstream: { kind: "tcp", host: "127.0.0.1", port: upstream.port },
      reconnectDelayMs: 20,
    });
    await proxy.start();
    cleanups.push(() => proxy.shutdown());

    const client = connectOrderedClient(frontPath);
    cleanups.push(() => client.close());
    await client.ready;

    const warmup = await client.request("brain_store", 301);
    expect(warmup.id).toBe(301);

    const request = client.request("brain_search", 302);
    for (let i = 0; i < 50 && upstream.connections() < 2; i++) await sleep(10);
    expect(upstream.connections()).toBe(2);

    heldCallback?.(new Error("stale direct write failed"));

    const res = await request;
    expect(res.id).toBe(302);
    expect((res.result as { instance?: string }).instance).toBe("A");
    expect(heldOnce).toBe(true);
    expect(upstream.connections()).toBe(2);
  });
});

describe("BrainlayerProxy docs", () => {
  test("documents per-client upstreams and markdownlint-compatible fences/headings", () => {
    const doc = readFileSync("docs/BRAINLAYER-PROXY.md", "utf8");
    expect(doc).not.toContain("single upstream");
    expect(doc).toContain("per front-client");
    expect(doc).toContain("```text");
    expect(doc).toContain("```ts");

    const lines = doc.split("\n");
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (/^#{1,6} /.test(line)) {
        expect(lines[i - 1] ?? "").toBe("");
        expect(lines[i + 1] ?? "").toBe("");
      }
      if (/^```/.test(line)) {
        if (!inFence) {
          expect(line).not.toBe("```");
          expect(lines[i - 1] ?? "").toBe("");
        }
        inFence = !inFence;
      }
    }
  });
});

describe("BrainlayerProxy stale-socket guard placement", () => {
  test("uses one ordered upstream write path with guarded stale-socket state", () => {
    const source = readFileSync("src/brainlayer-proxy/index.ts", "utf8");
    const flushCallback = source.slice(
      source.indexOf("target.write(buf, (err) => {"),
      source.indexOf("const bufferForReconnect"),
    );
    const clearsLock = flushCallback.indexOf("flushingPending = false");
    const staleReturn = flushCallback.indexOf("if (upstream !== target) return");
    expect(clearsLock).toBeGreaterThanOrEqual(0);
    expect(staleReturn).toBeGreaterThanOrEqual(0);
    expect(clearsLock).toBeLessThan(staleReturn);

    const onGone = source.slice(
      source.indexOf("const onGone = () => {"),
      source.indexOf('u.on("connect"'),
    );
    const activeBlock = onGone.slice(
      onGone.indexOf("if (upstream === u) {"),
      onGone.indexOf("};", onGone.indexOf("const onGone")),
    );
    expect(activeBlock).toContain("reconnectTimer = setTimeout(connect, delay)");
    expect(activeBlock).toContain(
      "delay = Math.min(delay * 2, this.#maxReconnectDelayMs)",
    );

    const writeFailure = source.slice(
      source.indexOf("const handleWriteFailure = ("),
      source.indexOf("const flushPending"),
    );
    const stateMutationGuard = writeFailure.indexOf("if (upstream === target)");
    const marksUnusable = writeFailure.indexOf("markUpstreamUnusable(target)");
    const destroysTarget = writeFailure.indexOf("target.destroy()");
    const resumesFlush = writeFailure.indexOf("flushPending()");
    expect(stateMutationGuard).toBeGreaterThanOrEqual(0);
    expect(marksUnusable).toBeGreaterThan(stateMutationGuard);
    expect(destroysTarget).toBeGreaterThan(stateMutationGuard);
    expect(resumesFlush).toBeGreaterThan(destroysTarget);

    expect(source).not.toContain("writeToReadyUpstream");
    expect(source.match(/\.write\(/g)?.length).toBe(2);
    expect(source).toContain("client.write(chunk)");
    expect(source).toContain("target.write(buf, (err) => {");

    const clientDataHandler = source.slice(
      source.indexOf('client.on("data"'),
      source.indexOf("const teardownClient"),
    );
    expect(clientDataHandler).toContain("bufferForReconnect(chunk)");
    expect(clientDataHandler).not.toContain(".write(");
  });
});
