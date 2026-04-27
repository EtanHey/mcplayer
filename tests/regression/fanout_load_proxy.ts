#!/usr/bin/env bun

import net from "node:net";
import { McpFrameReader, encodeMcpMessage } from "../../src/mcp-framing";

type McpMessage = Record<string, unknown>;

const SOCKET_PATH = process.env.MCPLAYER_SOCKET_PATH ?? "/tmp/mcplayer.sock";
const TARGET = process.env.MCPLAYER_FANOUT_TARGET ?? "fanout-timeout";
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.MCPLAYER_FANOUT_REQUEST_TIMEOUT_MS ?? "500", 10);
const PROXY_PORT = Number.parseInt(process.env.MCPLAYER_FANOUT_PROXY_PORT ?? "0", 10);
const HOST = process.env.MCPLAYER_FANOUT_PROXY_HOST ?? "127.0.0.1";

const PORT = Number.isFinite(PROXY_PORT) && PROXY_PORT > 0 ? PROXY_PORT : 0;
const REQUEST_TIMEOUT = Number.isFinite(REQUEST_TIMEOUT_MS) && REQUEST_TIMEOUT_MS > 0 ? REQUEST_TIMEOUT_MS : 500;

interface ProxyRequest {
  target?: string;
  call: {
    id: number | string;
    name: string;
    arguments?: Record<string, unknown>;
  };
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(req): Promise<Response> {
    if (req.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    if (new URL(req.url).pathname !== "/") {
      return new Response("not found", { status: 404 });
    }

    let parsed: ProxyRequest;
    try {
      parsed = (await req.json()) as ProxyRequest;
    } catch {
      return new Response("invalid json", { status: 400 });
    }

    if (!parsed?.call || !parsed.call.id || !parsed.call.name) {
      return new Response("invalid payload", { status: 400 });
    }

    const target = parsed.target ?? TARGET;
    try {
      const response = await forwardToMcplayer(target, parsed.call);
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(
        JSON.stringify({
          error: {
            code: -32000,
            message,
          },
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }
  },
});

const activePort = server.port;
console.log(`MCPLAYER_FANOUT_PROXY_URL=http://${HOST}:${activePort}/`);

function forwardToMcplayer(target: string, call: ProxyRequest["call"]): Promise<McpMessage> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: SOCKET_PATH });
    const reader = new McpFrameReader();
    const initializeId = "0";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("mcplayer call timeout"));
    }, REQUEST_TIMEOUT + 1000);
    let finished = false;

    const done = (error: Error | null, message?: McpMessage) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", handleError);
      if (!socket.destroyed) {
        socket.end();
      }
      if (error) {
        reject(error);
      } else if (message) {
        resolve(message);
      } else {
        reject(new Error("mcplayer response missing"));
      }
    };

    const handleError = (error: Error) => {
      done(error);
    };

    socket.on("error", handleError);

    const expectedInitSuffix = `:::mcplayer:::${initializeId}`;
    let initialized = false;
    const targetCallId = String(call.id);
    const expectedTargetId = `:::mcplayer:::${targetCallId}`;

    const initFrame = encodeMcpMessage({
      jsonrpc: "2.0",
      id: initializeId,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: {
          name: "fanout-load-proxy",
          version: "1.0.0",
        },
      },
    });

    const initializeNotify = encodeMcpMessage({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    const callFrame = encodeMcpMessage({
      jsonrpc: "2.0",
      id: call.id,
      method: "tools/call",
      params: {
        name: call.name,
        arguments: call.arguments,
      },
    });

    const onData = (chunk: Buffer) => {
      try {
        const messages = reader.push(chunk);
        for (const raw of messages) {
          const message = raw as McpMessage;
          if (typeof message.id === "string") {
            if (message.id.endsWith(expectedInitSuffix)) {
              initialized = true;
              continue;
            }

            if (message.id.endsWith(expectedTargetId)) {
              done(null, message);
            }
          } else if (typeof message.id === "number") {
            if (String(message.id) === initializeId) {
              initialized = true;
              continue;
            }
            if (String(message.id) === targetCallId) {
              done(null, message);
            }
          }
        }
      } catch (error) {
        handleError(error instanceof Error ? error : new Error(String(error)));
      }
    };

    const onClose = () => {
      if (initialized) {
        return;
      }
      done(new Error("mcplayer socket closed before response"));
    };

    socket.on("connect", () => {
      const header = `TARGET:${target}\n`;
      socket.write(header);
      socket.write(Buffer.from(initFrame));
      socket.write(Buffer.from(initializeNotify));
      socket.write(Buffer.from(callFrame));
    });

    socket.on("data", onData);
    socket.on("close", onClose);
  });
}
