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

function startCountingFakeBrainbarTcp(instance: string) {
  let connections = 0;
  const server = net.createServer((sock) => {
    connections++;
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
  }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object")
        resolve({ port: address.port, server, connections: () => connections });
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

  test("re-buffers client data when a ready upstream rejects a direct write", async () => {
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
