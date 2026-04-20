#!/usr/bin/env bun

import { appendFileSync } from "node:fs";
import { McpFrameReader, encodeMcpMessage } from "../../src/mcp-framing";

type JsonRpcMessage = Record<string, unknown>;

const reader = new McpFrameReader();
const logPath = process.env.MCPLAYER_LOAD_TEST_UPSTREAM_LOG;
let writeQueue = Promise.resolve();

function log(kind: string, payload: Record<string, unknown>): void {
  if (!logPath) {
    return;
  }

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

function responseDelayFor(clientIndex: number, sequence: number): number {
  return 100 + ((clientIndex * 37 + sequence * 43) % 400);
}

async function handleMessage(message: JsonRpcMessage): Promise<void> {
  log("recv", { id: message.id ?? null, method: message.method ?? null });

  if (message.method === "initialize") {
    await writeMessage({
      jsonrpc: "2.0",
      id: message.id ?? null,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "mock-mcp-upstream", version: "1.0.0" },
      },
    });
    log("send", { id: message.id ?? null, method: "initialize" });
    return;
  }

  if (message.method === "notifications/initialized") {
    return;
  }

  if (message.method === "tools/call") {
    const params = (message.params ?? {}) as Record<string, unknown>;
    const argumentsPayload = (params.arguments ?? {}) as Record<string, unknown>;
    const clientIndex = Number(argumentsPayload.clientIndex ?? -1);
    const sequence = Number(argumentsPayload.sequence ?? -1);
    const delayMs = responseDelayFor(clientIndex, sequence);

    setTimeout(() => {
      void writeMessage({
        jsonrpc: "2.0",
        id: message.id ?? null,
        result: {
          structuredContent: {
            clientIndex,
            sequence,
            upstreamPid: process.pid,
          },
          content: [
            {
              type: "text",
              text: JSON.stringify({ clientIndex, sequence, upstreamPid: process.pid }),
            },
          ],
        },
      }).then(() => {
        log("send", {
          id: message.id ?? null,
          clientIndex,
          sequence,
          delayMs,
        });
      });
    }, delayMs);
    return;
  }

  await writeMessage({
    jsonrpc: "2.0",
    id: message.id ?? null,
    error: {
      code: -32601,
      message: `unsupported method: ${String(message.method ?? "unknown")}`,
    },
  });
  log("send", { id: message.id ?? null, method: message.method ?? null });
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
