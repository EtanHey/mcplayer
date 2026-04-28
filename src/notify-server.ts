#!/usr/bin/env bun

import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpFrameReader, encodeMcpMessage } from "./mcp-framing";

interface NotifyArgs {
  title: string;
  body: string;
  subtitle?: string;
  priority?: "min" | "low" | "default" | "high" | "urgent";
  sound?: string;
  open?: string;
  group?: string;
}

interface BackendResult {
  backend: string;
  delivered: boolean;
  unsupported: string[];
}

const TOOL = {
  name: "notify",
  description:
    "Send a native macOS notification. Uses terminal-notifier when available and falls back to osascript.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Notification title" },
      body: { type: "string", description: "Notification body" },
      subtitle: { type: "string", description: "Optional subtitle" },
      priority: {
        type: "string",
        enum: ["min", "low", "default", "high", "urgent"],
        description: "Notification priority hint",
      },
      sound: { type: "string", description: "Optional macOS sound name" },
      open: { type: "string", description: "Optional URL to open on click" },
      group: { type: "string", description: "Optional terminal-notifier group id" },
    },
    required: ["title", "body"],
    additionalProperties: false,
  },
};

const frameReader = new McpFrameReader();
let operations = Promise.resolve();

process.stdin.on("data", (chunk: Buffer) => {
  const copied = Buffer.from(chunk);
  operations = operations
    .then(() => handleChunk(copied))
    .catch((error) => {
      writeMessage({
        jsonrpc: "2.0",
        method: "notifications/message",
        params: {
          level: "error",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    });
});

async function handleChunk(chunk: Buffer): Promise<void> {
  const messages = frameReader.push(chunk);
  for (const message of messages) {
    await handleMessage(message as Record<string, unknown>);
  }
}

async function handleMessage(message: Record<string, unknown>): Promise<void> {
  const id = message.id ?? null;
  const method = typeof message.method === "string" ? message.method : "";

  if (method === "initialize") {
    writeMessage({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "mcplayer-notify", version: "0.1.0" },
      },
    });
    return;
  }

  if (method === "notifications/initialized") {
    return;
  }

  if (method === "tools/list") {
    writeMessage({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [TOOL],
      },
    });
    return;
  }

  if (method === "tools/call") {
    const params = (message.params ?? {}) as Record<string, unknown>;
    const name = typeof params.name === "string" ? params.name : "";
    if (name !== TOOL.name) {
      writeError(id, -32601, `unknown tool: ${name}`);
      return;
    }

    const parsed = parseNotifyArgs(params.arguments);
    if (!parsed.ok) {
      writeError(id, -32602, parsed.error);
      return;
    }

    const backend = runBackend(parsed.value);
    if (!backend.ok) {
      writeError(id, -32000, backend.error);
      return;
    }

    writeMessage({
      jsonrpc: "2.0",
      id,
      result: {
        content: [
          {
            type: "text",
            text: `Notification delivered via ${backend.value.backend}`,
          },
        ],
        structuredContent: {
          delivered: backend.value.delivered,
          backend: backend.value.backend,
          unsupported: backend.value.unsupported,
          title: parsed.value.title,
          body: parsed.value.body,
          subtitle: parsed.value.subtitle ?? null,
          priority: parsed.value.priority ?? "default",
          sound: parsed.value.sound ?? null,
          open: parsed.value.open ?? null,
          group: parsed.value.group ?? null,
        },
      },
    });
    return;
  }

  if (id !== null) {
    writeError(id, -32601, `unsupported method: ${method}`);
  }
}

function parseNotifyArgs(
  raw: unknown,
): { ok: true; value: NotifyArgs } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "notify arguments must be an object" };
  }

  const args = raw as Record<string, unknown>;
  const title = stringField(args.title);
  const body = stringField(args.body);
  if (!title) {
    return { ok: false, error: "notify requires title" };
  }
  if (!body) {
    return { ok: false, error: "notify requires body" };
  }

  const priority = stringField(args.priority);
  if (priority && !["min", "low", "default", "high", "urgent"].includes(priority)) {
    return { ok: false, error: `unsupported priority: ${priority}` };
  }

  return {
    ok: true,
    value: {
      title,
      body,
      subtitle: stringField(args.subtitle) || undefined,
      priority: (priority as NotifyArgs["priority"]) || undefined,
      sound: stringField(args.sound) || undefined,
      open: stringField(args.open) || undefined,
      group: stringField(args.group) || undefined,
    },
  };
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function runBackend(args: NotifyArgs): { ok: true; value: BackendResult } | { ok: false; error: string } {
  const backendPath =
    process.env.MCPLAYER_NOTIFY_BACKEND_BIN ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/mcplayer-notify-backend");

  const command = [
    backendPath,
    "--title",
    args.title,
    "--body",
    args.body,
  ];

  if (args.subtitle) {
    command.push("--subtitle", args.subtitle);
  }
  if (args.priority) {
    command.push("--priority", args.priority);
  }
  if (args.sound) {
    command.push("--sound", args.sound);
  }
  if (args.open) {
    command.push("--open", args.open);
  }
  if (args.group) {
    command.push("--group", args.group);
  }

  const result = Bun.spawnSync(command, {
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    const errorText =
      result.stderr.toString("utf8").trim() || result.stdout.toString("utf8").trim() || "notify backend failed";
    return { ok: false, error: errorText };
  }

  return { ok: true, value: parseBackendResult(result.stdout.toString("utf8")) };
}

function parseBackendResult(stdout: string): BackendResult {
  const result: BackendResult = {
    backend: "unknown",
    delivered: false,
    unsupported: [],
  };

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const [key, ...rest] = line.split("=");
    const value = rest.join("=");
    if (key === "backend") {
      result.backend = value;
    } else if (key === "delivered") {
      result.delivered = value === "1";
    } else if (key === "unsupported" && value.length > 0) {
      result.unsupported = value.split(",").filter(Boolean);
    }
  }

  return result;
}

function writeError(id: unknown, code: number, message: string): void {
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
}

function writeMessage(message: unknown): void {
  process.stdout.write(encodeMcpMessage(message));
}
