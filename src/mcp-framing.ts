export class McpFrameReader {
  #buffer = Buffer.alloc(0);

  push(chunk: Buffer | Uint8Array): unknown[] {
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
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
      if (!Number.isInteger(bodyLength) || bodyLength < 0) {
        throw new Error(`invalid Content-Length header: ${contentLength}`);
      }

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

export function encodeMcpMessage(message: unknown): Uint8Array {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"), body]);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
