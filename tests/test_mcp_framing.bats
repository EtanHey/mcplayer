#!/usr/bin/env bats

@test "McpFrameReader keeps the bad frame buffered when JSON parsing fails" {
  run bun --cwd "$BATS_TEST_DIRNAME/.." --eval '
import { McpFrameReader, encodeMcpMessage } from "./src/mcp-framing";

const reader = new McpFrameReader();
const invalidBody = "{\"broken\":";
const invalidFrame = Buffer.concat([
  Buffer.from(`Content-Length: ${Buffer.byteLength(invalidBody, "utf8")}\r\n\r\n`, "utf8"),
  Buffer.from(invalidBody, "utf8"),
]);
const validFrame = Buffer.from(encodeMcpMessage({ jsonrpc: "2.0", id: 7, result: { ok: true } }));

let firstError = "";
try {
  reader.push(Buffer.concat([invalidFrame, validFrame]));
  console.error("expected first push to throw");
  process.exit(1);
} catch (error) {
  firstError = error instanceof Error ? error.message : String(error);
}

if (!firstError.includes("JSON")) {
  console.error(`expected JSON parse failure, got: ${firstError}`);
  process.exit(1);
}

try {
  reader.push(Buffer.alloc(0));
  console.error("expected second push to throw on the same buffered bad frame");
  process.exit(1);
} catch (error) {
  const secondError = error instanceof Error ? error.message : String(error);
  if (!secondError.includes("JSON")) {
    console.error(`expected repeated JSON parse failure, got: ${secondError}`);
    process.exit(1);
  }
}
'

  [ "$status" -eq 0 ]
}
