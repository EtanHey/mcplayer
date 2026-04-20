import net from "node:net";
import type { McplayerConfig } from "./config";

class McpFrameReader {
  #buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const messages: unknown[] = [];

    while (true) {
      const headerEnd = this.#buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        break;
      }

      const headerText = this.#buffer.subarray(0, headerEnd).toString("utf8");
      const contentLength = headerText
        .split("\r\n")
        .find((line) => line.toLowerCase().startsWith("content-length:"));

      if (!contentLength) {
        throw new Error("missing Content-Length header");
      }

      const bodyLength = Number(contentLength.split(":", 2)[1]?.trim() ?? "0");
      const frameEnd = headerEnd + 4 + bodyLength;
      if (this.#buffer.length < frameEnd) {
        break;
      }

      const body = this.#buffer.subarray(headerEnd + 4, frameEnd).toString("utf8");
      this.#buffer = this.#buffer.subarray(frameEnd);
      messages.push(JSON.parse(body));
    }

    return messages;
  }
}

function encodeMcpMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"), body]);
}

async function connectUnixSocket(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath, () => resolve(socket));
    socket.once("error", reject);
  });
}

async function writeAll(socket: net.Socket, buffer: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null) => {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };

    const wroteImmediately = socket.write(buffer, finish);
    if (!wroteImmediately) {
      socket.once("drain", () => finish());
    }
  });
}

async function callBrainStore(
  socketPath: string,
  project: string,
  tags: string[],
  importance: number,
  content: string,
  timeoutMs = 750,
): Promise<void> {
  const socket = await connectUnixSocket(socketPath);
  const reader = new McpFrameReader();
  let timeoutHandle: NodeJS.Timeout | undefined;

  const cleanup = () => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    }
    socket.removeAllListeners("data");
    socket.removeAllListeners("error");
    socket.removeAllListeners("timeout");
    socket.end();
    socket.destroy();
  };

  const waitForResponse = async (expectedId: number): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        try {
          const messages = reader.push(Buffer.from(chunk));
          for (const message of messages) {
            const payload = message as Record<string, unknown>;
            if (payload.id === expectedId) {
              socket.off("data", onData);
              socket.off("error", onError);
              socket.off("timeout", onTimeout);
              resolve();
              return;
            }
          }
        } catch (error) {
          socket.off("data", onData);
          socket.off("error", onError);
          socket.off("timeout", onTimeout);
          reject(error);
        }
      };

      const onError = (error: Error) => {
        socket.off("data", onData);
        socket.off("timeout", onTimeout);
        reject(error);
      };

      const onTimeout = () => {
        socket.off("data", onData);
        socket.off("error", onError);
        reject(new Error(`brainbar log timeout after ${timeoutMs}ms`));
      };

      socket.on("data", onData);
      socket.once("error", onError);
      socket.once("timeout", onTimeout);
    });
  };

  timeoutHandle = setTimeout(() => {
    socket.emit("timeout");
  }, timeoutMs);

  try {
    await writeAll(
      socket,
      encodeMcpMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "mcplayer-daemon", version: "0.1.0" },
        },
      }),
    );
    await waitForResponse(1);

    await writeAll(
      socket,
      encodeMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    await writeAll(
      socket,
      encodeMcpMessage({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "brain_store",
          arguments: {
            content,
            project,
            tags,
            importance,
          },
        },
      }),
    );
    await waitForResponse(2);
  } finally {
    cleanup();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface LogPayload {
  [key: string]: unknown;
}

export class McplayerLogger {
  #config: Pick<McplayerConfig, "brainbarSocketPath" | "logProject" | "logTags" | "logImportance">;
  #queue = Promise.resolve();
  #disabled = Bun.env.MCPLAYER_DISABLE_BRAINBAR_LOGS === "1";

  constructor(config: McplayerConfig) {
    this.#config = config;
  }

  debug(event: string, payload: LogPayload = {}): void {
    this.#emit("debug", event, payload);
  }

  info(event: string, payload: LogPayload = {}): void {
    this.#emit("info", event, payload);
  }

  warn(event: string, payload: LogPayload = {}): void {
    this.#emit("warn", event, payload);
  }

  error(event: string, payload: LogPayload = {}): void {
    this.#emit("error", event, payload);
  }

  #emit(level: string, event: string, payload: LogPayload): void {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      event,
      payload,
    };

    console.log(JSON.stringify(entry));

    if (this.#disabled) {
      return;
    }

    this.#queue = this.#queue
      .catch(() => undefined)
      .then(async () => {
        try {
          await callBrainStore(
            this.#config.brainbarSocketPath,
            this.#config.logProject,
            this.#config.logTags,
            this.#config.logImportance,
            JSON.stringify(entry),
          );
        } catch (error) {
          console.error(
            JSON.stringify({
              timestamp: new Date().toISOString(),
              level: "error",
              event: "brainbar-log-failed",
              payload: {
                error: error instanceof Error ? error.message : String(error),
              },
            }),
          );
        }
      });
  }
}
