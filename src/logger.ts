import net from "node:net";
import type { McplayerConfig } from "./config";
import { McpFrameReader, encodeMcpMessage } from "./mcp-framing";

async function connectUnixSocket(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);

    const onConnect = () => {
      socket.off("error", onError);
      resolve(socket);
    };

    const onError = (error: Error) => {
      socket.off("connect", onConnect);
      reject(error);
    };

    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

async function writeAll(socket: net.Socket, buffer: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      socket.off("drain", onDrain);
      socket.off("error", onError);
    };

    const finish = (error?: Error | null) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };

    const onDrain = () => {
      finish();
    };

    const onError = (error: Error) => {
      finish(error);
    };

    const wroteImmediately = socket.write(buffer, finish);
    if (!wroteImmediately) {
      socket.once("drain", onDrain);
      socket.once("error", onError);
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

  const cleanup = () => {
    socket.removeAllListeners("data");
    socket.removeAllListeners("error");
    socket.removeAllListeners("end");
    socket.removeAllListeners("close");
    socket.end();
    socket.destroy();
  };

  const waitForResponse = async (expectedId: number): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeoutHandle: NodeJS.Timeout | undefined;

      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
        }
        socket.off("data", onData);
        socket.off("error", onError);
        socket.off("end", onEnd);
        socket.off("close", onClose);

        if (error) {
          reject(error);
          return;
        }
        resolve();
      };

      const onData = (chunk: Buffer) => {
        try {
          const messages = reader.push(Buffer.from(chunk));
          for (const message of messages) {
            const payload = message as Record<string, unknown>;
            if (payload.id === expectedId) {
              if (Object.prototype.hasOwnProperty.call(payload, "error")) {
                const responseError = payload.error as { message?: string } | undefined;
                finish(new Error(responseError?.message ?? "brainbar MCP error response"));
                return;
              }
              finish();
              return;
            }
          }
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      };

      const onError = (error: Error) => {
        finish(error);
      };

      const onEnd = () => {
        finish(new Error("brainbar log socket ended before response"));
      };

      const onClose = () => {
        finish(new Error("brainbar log socket closed before response"));
      };

      timeoutHandle = setTimeout(() => {
        finish(new Error(`brainbar log timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      socket.on("data", onData);
      socket.once("error", onError);
      socket.once("end", onEnd);
      socket.once("close", onClose);
    });
  };

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
