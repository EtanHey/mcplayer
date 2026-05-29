// mcplayer durable-contract protocol — the client-facing control/queue surface.
// Pure, zero-dependency. NDJSON + JSON-RPC 2.0. This is the STABLE surface the MCL
// track (`metacomm`) mocks; keep it in sync with docs/PROTOCOL.md.

// ---------------------------------------------------------------------------
// NDJSON framing — one JSON value per line, messages separated by "\n".
// (Distinct from the broker↔upstream-MCP Content-Length/LSP framing in mcp-framing.ts.)
// ---------------------------------------------------------------------------

/** Encode one value as a single NDJSON line (JSON + trailing newline). */
export function encodeLine(value: unknown): string {
  return JSON.stringify(value) + "\n";
}

/**
 * Incremental NDJSON line decoder. Feed arbitrary chunks; get back the complete
 * JSON values whose terminating "\n" has arrived. Partial trailing lines are
 * buffered until their newline shows up. Blank lines are skipped.
 */
export class NdjsonDecoder {
  #buffer = "";

  push(chunk: Buffer | Uint8Array | string): unknown[] {
    this.#buffer +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");

    const out: unknown[] = [];
    let newlineIdx: number;
    while ((newlineIdx = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, newlineIdx);
      this.#buffer = this.#buffer.slice(newlineIdx + 1);
      if (line.trim().length === 0) continue; // skip blank lines
      out.push(JSON.parse(line));
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 strict classification.
// ---------------------------------------------------------------------------

export type MessageKind = "request" | "notification" | "response" | "invalid";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Classify a parsed JSON-RPC 2.0 message:
 *  - id + method            => "request"  (gets exactly one response)
 *  - method, no id          => "notification" (server MUST NOT respond)
 *  - id + (result | error)  => "response"
 *  - anything else / wrong jsonrpc => "invalid"
 */
export function classify(msg: unknown): MessageKind {
  if (!isObject(msg) || msg.jsonrpc !== "2.0") return "invalid";

  const hasId = "id" in msg && msg.id !== undefined;
  const hasMethod = typeof msg.method === "string";
  const hasResult = "result" in msg;
  const hasError = "error" in msg;

  if (hasMethod && hasId) return "request";
  if (hasMethod && !hasId) return "notification";
  if (hasId && (hasResult || hasError)) {
    if (hasResult && hasError) return "invalid";
    return "response";
  }
  return "invalid";
}

// ---------------------------------------------------------------------------
// Reserved error codes — pinned for cross-language parser stability.
// ---------------------------------------------------------------------------

export const ERR = {
  UNKNOWN_SESSION: -32001,
  UNKNOWN_CHANNEL: -32002,
  ENGINE_NOT_UP: -32003,
  WAL_FULL: -32004,
} as const;

// ---------------------------------------------------------------------------
// Param validation for the 5 contract methods (see docs/PROTOCOL.md).
// ---------------------------------------------------------------------------

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

type Validator = (p: Record<string, unknown>) => ValidationResult;

const ok: ValidationResult = { ok: true };
const bad = (error: string): ValidationResult => ({ ok: false, error });

const VALIDATORS: Record<string, Validator> = {
  "mcplayer.connect": (p) =>
    isStr(p.client_id) ? ok : bad("client_id must be a string"),

  "mcplayer.publish": (p) => {
    if (!isStr(p.channel)) return bad("channel must be a string");
    if (!isStr(p.message_id)) return bad("message_id must be a string");
    if (!("payload" in p)) return bad("payload is required");
    if ("durable" in p && typeof p.durable !== "boolean")
      return bad("durable must be a boolean");
    return ok;
  },

  "mcplayer.subscribe": (p) => {
    if (!isStr(p.channel)) return bad("channel must be a string");
    if ("from_offset" in p && !isNum(p.from_offset))
      return bad("from_offset must be a number");
    return ok;
  },

  "mcplayer.ack": (p) => {
    if (!isStr(p.channel)) return bad("channel must be a string");
    if (!isStr(p.message_id)) return bad("message_id must be a string");
    return ok;
  },

  "mcplayer.status": (p) => {
    if ("engine" in p && !isStr(p.engine))
      return bad("engine must be a string");
    return ok;
  },
};

/** Validate params for one of the 5 contract methods. Unknown method => not ok. */
export function validateParams(
  method: string,
  params: unknown,
): ValidationResult {
  const v = VALIDATORS[method];
  if (!v) return bad(`unknown method: ${method}`);
  if (!isObject(params)) return bad("params must be an object");
  return v(params);
}
