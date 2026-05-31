// P1b — LOUD degradation + frame-aware per-request timeout.
//
// The P0 proxy is a transparent byte-relay: a request issued while the upstream
// is down (or a request the upstream accepts but never answers) hangs the agent
// SILENTLY. P1b makes the proxy frame-aware on the front side so it can answer a
// pending request id with a LOUD JSON-RPC error instead of hanging — while
// keeping the connection open and the upstream relay otherwise transparent.

import { afterEach, expect, test } from "bun:test";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeLine, NdjsonDecoder, classify } from "../../src/protocol";
import { BrainlayerProxy } from "../../src/brainlayer-proxy";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Json = Record<string, unknown>;

// An upstream that accepts the connection and reads bytes but NEVER replies —
// models a BrainBar that holds the request (slow query / DB-lock) with no
// response, the case that hangs a Codex worker indefinitely today.
function startSilentUpstream(socketPath: string): Promise<net.Server> {
  const server = net.createServer((sock) => {
    sock.on("data", () => {
      /* swallow — never respond */
    });
  });
  return new Promise((resolve) =>
    server.listen(socketPath, () => resolve(server)),
  );
}

// A front client that collects parsed NDJSON messages and lets the test await
// the next message carrying a given id (or null if none arrives in time).
function connectClient(socketPath: string) {
  const sock = net.createConnection(socketPath);
  const decoder = new NdjsonDecoder();
  const inbox: Json[] = [];
  sock.on("data", (chunk) => {
    for (const m of decoder.push(chunk) as Json[]) inbox.push(m);
  });
  return {
    sock,
    ready: new Promise<void>((res, rej) => {
      sock.once("connect", res);
      sock.once("error", rej);
    }),
    send(msg: Json) {
      sock.write(encodeLine(msg));
    },
    async waitForId(id: number, timeoutMs: number): Promise<Json | null> {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const hit = inbox.find((m) => m.id === id);
        if (hit) return hit;
        await sleep(10);
      }
      return null;
    },
    messagesForId(id: number): Json[] {
      return inbox.filter((m) => m.id === id);
    },
  };
}

test("times out a pending request with a LOUD JSON-RPC error carrying its id when the upstream never responds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "blp-p1b-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const upstreamPath = join(dir, "up.sock");
  const frontPath = join(dir, "front.sock");

  const upstream = await startSilentUpstream(upstreamPath);
  // Non-blocking: the proxy still holds an upstream connection at teardown, and
  // cleanups run LIFO (proxy.shutdown runs after this), so awaiting close()'s
  // all-connections-drained callback here would deadlock the afterEach.
  cleanups.push(() => {
    upstream.close();
  });

  const proxy = new BrainlayerProxy({
    frontSocketPath: frontPath,
    upstream: { kind: "unix", path: upstreamPath },
    requestTimeoutMs: 200,
  });
  await proxy.start();
  cleanups.push(() => proxy.shutdown());

  const client = connectClient(frontPath);
  cleanups.push(() => client.sock.destroy());
  await client.ready;

  client.send({ jsonrpc: "2.0", id: 1, method: "brain_search", params: {} });

  // The proxy must synthesize a response for id 1 within a small multiple of the
  // timeout, instead of letting the agent hang forever on the silent upstream.
  const msg = await client.waitForId(1, 1500);

  expect(msg).not.toBeNull();
  expect(classify(msg!)).toBe("response");
  expect(msg!.id).toBe(1);
  expect(msg!.error).toBeDefined();
  expect(String((msg!.error as Json).message)).toContain("timed out");
  // LOUD, not a teardown: the connection stays open for subsequent requests.
  expect(client.sock.destroyed).toBe(false);
});

function startDelayedResponseUpstream(
  socketPath: string,
  delayMs: number,
): Promise<net.Server> {
  const server = net.createServer((sock) => {
    const decoder = new NdjsonDecoder();
    sock.on("data", (chunk) => {
      for (const msg of decoder.push(chunk) as Json[]) {
        if (msg.method === undefined) continue;
        setTimeout(() => {
          sock.write(
            encodeLine({
              jsonrpc: "2.0",
              id: msg.id,
              result: { ok: true, late: true },
            }),
          );
        }, delayMs);
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(socketPath, () => resolve(server)),
  );
}

test("drops a late real upstream response after an id was already answered by the timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "blp-p1b-late-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const upstreamPath = join(dir, "up.sock");
  const frontPath = join(dir, "front.sock");

  const upstream = await startDelayedResponseUpstream(upstreamPath, 300);
  cleanups.push(() => {
    upstream.close();
  });

  const proxy = new BrainlayerProxy({
    frontSocketPath: frontPath,
    upstream: { kind: "unix", path: upstreamPath },
    requestTimeoutMs: 100,
    degradedMs: 5000,
  });
  await proxy.start();
  cleanups.push(() => proxy.shutdown());

  const client = connectClient(frontPath);
  cleanups.push(() => client.sock.destroy());
  await client.ready;

  client.send({ jsonrpc: "2.0", id: 7, method: "brain_search", params: {} });

  const timeout = await client.waitForId(7, 1500);
  expect(timeout).not.toBeNull();
  expect(timeout!.error).toBeDefined();
  expect(String((timeout!.error as Json).message)).toContain("timed out");

  await sleep(500);

  expect(client.messagesForId(7)).toHaveLength(1);
  expect(client.messagesForId(7)[0].result).toBeUndefined();
  expect(client.sock.destroyed).toBe(false);
});

// A fake BrainBar that echoes a result for any request — used to prove recovery.
function startEchoUpstream(
  socketPath: string,
  instance: string,
): Promise<net.Server> {
  const server = net.createServer((sock) => {
    const decoder = new NdjsonDecoder();
    sock.on("data", (chunk) => {
      for (const msg of decoder.push(chunk) as Json[]) {
        if (msg.method === undefined) continue;
        sock.write(
          encodeLine({
            jsonrpc: "2.0",
            id: msg.id,
            result: { ok: true, instance },
          }),
        );
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(socketPath, () => resolve(server)),
  );
}

test("when the upstream is DOWN, surfaces a LOUD degraded error within degradedMs, then auto-recovers when it returns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "blp-p1b-deg-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const upstreamPath = join(dir, "up.sock");
  const frontPath = join(dir, "front.sock");

  // No upstream listening yet → every connect attempt fails → upstream stays
  // down while a request sits pending.
  const proxy = new BrainlayerProxy({
    frontSocketPath: frontPath,
    upstream: { kind: "unix", path: upstreamPath },
    degradedMs: 150,
    requestTimeoutMs: 5000, // far higher, so the DEGRADED path is what fires
    reconnectDelayMs: 50,
    maxReconnectDelayMs: 100,
  });
  await proxy.start();
  cleanups.push(() => proxy.shutdown());

  const client = connectClient(frontPath);
  cleanups.push(() => client.sock.destroy());
  await client.ready;

  client.send({ jsonrpc: "2.0", id: 1, method: "brain_search", params: {} });

  const degraded = await client.waitForId(1, 1500);
  expect(degraded).not.toBeNull();
  expect(classify(degraded!)).toBe("response");
  expect(degraded!.id).toBe(1);
  expect(degraded!.error).toBeDefined();
  const message = String((degraded!.error as Json).message).toLowerCase();
  expect(message).toContain("degraded");
  expect(message).toContain("unreachable");
  expect(client.sock.destroyed).toBe(false);

  // Upstream returns → a fresh request must succeed with NO agent restart.
  const upstream = await startEchoUpstream(upstreamPath, "recovered");
  // Non-blocking: the proxy still holds an upstream connection at teardown, and
  // cleanups run LIFO (proxy.shutdown runs after this), so awaiting close()'s
  // all-connections-drained callback here would deadlock the afterEach.
  cleanups.push(() => {
    upstream.close();
  });

  client.send({ jsonrpc: "2.0", id: 2, method: "brain_search", params: {} });
  const recovered = await client.waitForId(2, 2000);
  expect(recovered).not.toBeNull();
  expect(classify(recovered!)).toBe("response");
  expect(recovered!.error).toBeUndefined();
  expect((recovered!.result as Json).ok).toBe(true);
});
