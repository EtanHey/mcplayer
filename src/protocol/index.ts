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
 *
 * Buffers RAW BYTES and decodes only complete lines. The line separator is the
 * 0x0A byte, which can never appear inside a multi-byte UTF-8 sequence (all
 * continuation/lead bytes are >= 0x80), so a multi-byte character split across
 * chunk boundaries — expected over a UDS — is reassembled intact rather than
 * being corrupted to U+FFFD by a premature per-chunk decode.
 */
export interface NdjsonParseError {
  line: string;
  error: string;
}

export class NdjsonDecoder {
  #buffer: Buffer = Buffer.alloc(0);
  /**
   * Malformed lines encountered (could not JSON.parse). Recorded rather than
   * thrown: one corrupt frame must NOT kill a persistent socket nor discard the
   * valid messages parsed alongside it in the same push() (a durable bus must
   * not silently lose good frames because a different frame was bad). Callers
   * that want fail-loud behavior inspect this after each push().
   */
  readonly errors: NdjsonParseError[] = [];

  push(chunk: Buffer | Uint8Array | string): unknown[] {
    const incoming =
      typeof chunk === "string"
        ? Buffer.from(chunk, "utf8")
        : Buffer.from(chunk);
    this.#buffer =
      this.#buffer.length === 0
        ? incoming
        : Buffer.concat([this.#buffer, incoming]);

    const out: unknown[] = [];
    let nl: number;
    while ((nl = this.#buffer.indexOf(0x0a)) !== -1) {
      const lineBytes = this.#buffer.subarray(0, nl); // one complete line, raw
      this.#buffer = this.#buffer.subarray(nl + 1);
      const text = lineBytes.toString("utf8").trim(); // decode only when complete
      if (text.length === 0) continue; // skip blank lines
      try {
        out.push(JSON.parse(text));
      } catch (e) {
        // Record and continue — never lose the valid messages already in `out`,
        // and never advance past or re-process this complete (but invalid) line.
        this.errors.push({ line: text, error: (e as Error).message });
      }
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

  // A method message carrying result/error mixes request/notification with
  // response shape — illegal under strict JSON-RPC 2.0.
  if (hasMethod && (hasResult || hasError)) return "invalid";
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
  // hasOwnProperty guard: a bare VALIDATORS[method] walks the prototype chain, so
  // "constructor"/"toString"/etc. would resolve to inherited Object.prototype
  // methods and bypass this unknown-method rejection.
  const v = Object.prototype.hasOwnProperty.call(VALIDATORS, method)
    ? VALIDATORS[method]
    : undefined;
  if (!v) return bad(`unknown method: ${method}`);
  if (!isObject(params)) return bad("params must be an object");
  return v(params);
}
