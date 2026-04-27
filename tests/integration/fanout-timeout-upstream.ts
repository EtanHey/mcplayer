#!/usr/bin/env bun

import { McpFrameReader, encodeMcpMessage } from "../../src/mcp-framing";

type JsonRpcMessage = Record<string, unknown>;

const reader = new McpFrameReader();
let writeQueue = Promise.resolve();
const logPath = process.env.MCPLAYER_FANOUT_UPSTREAM_LOG;

function log(kind: string, payload: Record<string, unknown>): void {
  if (!logPath) {
    return;
  }

  import("node:fs").then(({ appendFileSync }) => {
    appendFileSync(
      logPath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        pid: process.pid,
        kind,
        payload,
      })}\n`,
      "utf8",
    );
  }).catch(() => undefined);
}

function responseDelayFor(
  call: { delayMs?: number; delay_ms?: number },
): number {
  const requestedDelay = Number(
    call.delayMs ?? call.delay_ms ?? 0,
  );
  if (Number.isFinite(requestedDelay) && requestedDelay >= 0) {
    return requestedDelay;
  }

  return 0;
}

async function writeMessage(message: JsonRpcMessage): Promise<void> {
  const payload = encodeMcpMessage(message);
  const writePromise = writeQueue.then(
    () =>
      new Promise<void>((resolve, reject) => {
        process.stdout.write(Buffer.from(payload), (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  );
  writeQueue = writePromise.catch(() => undefined);
  return writePromise;
}

function sendResult(id: unknown, text: string): Promise<void> {
  return writeMessage({
    jsonrpc: "2.0",
    id,
    result: {
      structuredContent: {
        echoed: text,
      },
      content: [{
        type: "text",
        text,
      }],
    },
  });
}

function sendError(id: unknown, code: number, message: string): Promise<void> {
  return writeMessage({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  });
}

async function handleMessage(message: JsonRpcMessage): Promise<void> {
  const requestId = message.id;
  const method = message.method;
  const params = (message.params ?? {}) as Record<string, unknown>;
  const args = (params.arguments ?? {}) as Record<string, unknown>;

  log("recv", { id: requestId, method });

  if (method === "initialize") {
    await writeMessage({
      jsonrpc: "2.0",
      id: requestId,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "fanout-timeout-upstream", version: "1.0.0" },
      },
    });
    log("send", { id: requestId, phase: "initialize" });
    return;
  }

  if (method === "notifications/initialized") {
    return;
  }

  if (method !== "tools/call") {
    await sendError(requestId, -32601, `unsupported method: ${String(method ?? "unknown")}`);
    log("send", { id: requestId, phase: "unsupported" });
    return;
  }

  const toolName = String((params.name ?? "") as string);
  const delayMs = responseDelayFor(args);

  if (toolName === "timeout") {
    const payload = JSON.stringify({
      id: requestId,
      reason: "simulated fanout timeout",
      delayMs,
    });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await sendError(requestId, -32000, payload);
    log("send", { id: requestId, phase: "timeout", delayMs });
    return;
  }

  if (toolName === "invalid") {
    const payload = JSON.stringify({ id: requestId, delayMs });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await sendError(requestId, -32601, payload);
    log("send", { id: requestId, phase: "invalid", delayMs });
    return;
  }

  const payload = JSON.stringify({
    id: requestId,
    name: toolName,
    delayMs,
  });
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  await sendResult(requestId, payload);
  log("send", { id: requestId, phase: "result", delayMs });
}

process.stdin.on("data", (chunk: Buffer) => {
  const messages = reader.push(chunk);
  for (const message of messages) {
    void handleMessage(message as JsonRpcMessage);
  }
});

process.stdin.on("end", async () => {
  await writeQueue.catch(() => undefined);
  process.exit(0);
});

process.stdin.resume();
