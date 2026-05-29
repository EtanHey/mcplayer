// RED contract tests for the mcplayer durable-contract protocol package (D0).
// Authored by mcplayer-LEAD as the executable spec; mcplayerCodex implements
// src/protocol/ until these pass. This is the exact surface MCL's mock mirrors —
// see docs/PROTOCOL.md. Run: bun test tests/contract/protocol.test.ts
import { describe, expect, test } from "bun:test";
import {
  ERR,
  NdjsonDecoder,
  classify,
  encodeLine,
  validateParams,
} from "../../src/protocol";

describe("NDJSON framing", () => {
  test("encodeLine appends exactly one trailing newline", () => {
    expect(encodeLine({ a: 1 })).toBe('{"a":1}\n');
  });

  test("decoder yields one object per complete line", () => {
    const d = new NdjsonDecoder();
    const out = d.push(Buffer.from('{"x":1}\n{"y":2}\n'));
    expect(out).toEqual([{ x: 1 }, { y: 2 }]);
  });

  test("decoder buffers a partial line until its newline arrives", () => {
    const d = new NdjsonDecoder();
    expect(d.push(Buffer.from('{"x":'))).toEqual([]);
    expect(d.push(Buffer.from("1}\n"))).toEqual([{ x: 1 }]);
  });

  test("decoder tolerates blank lines (skips them)", () => {
    const d = new NdjsonDecoder();
    expect(d.push(Buffer.from('\n{"x":1}\n\n'))).toEqual([{ x: 1 }]);
  });

  test("decoder throws on invalid JSON", () => {
    const d = new NdjsonDecoder();
    expect(() => d.push(Buffer.from('{"invalid\n'))).toThrow();
  });

  test("decoder throws on malformed JSON with helpful context", () => {
    const d = new NdjsonDecoder();
    expect(() =>
      d.push(Buffer.from('{"unclosed": "string\n')),
    ).toThrow();
  });
});

describe("JSON-RPC 2.0 strict classification", () => {
  test("id + method => request", () => {
    expect(
      classify({
        jsonrpc: "2.0",
        id: 1,
        method: "mcplayer.connect",
        params: {},
      }),
    ).toBe("request");
  });
  test("method, no id => notification (server MUST NOT respond)", () => {
    expect(
      classify({ jsonrpc: "2.0", method: "mcplayer.message", params: {} }),
    ).toBe("notification");
  });
  test("id + result => response", () => {
    expect(classify({ jsonrpc: "2.0", id: 1, result: {} })).toBe("response");
  });
  test("id + error => response", () => {
    expect(
      classify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603, message: "x" },
      }),
    ).toBe("response");
  });
  test("missing jsonrpc:'2.0' => invalid", () => {
    expect(classify({ id: 1, method: "x" })).toBe("invalid");
    expect(classify({ jsonrpc: "1.0", id: 1, method: "x" })).toBe("invalid");
  });

  test("response with both result and error => invalid (JSON-RPC 2.0 spec)", () => {
    expect(
      classify({
        jsonrpc: "2.0",
        id: 1,
        result: {},
        error: { code: -32603, message: "x" },
      }),
    ).toBe("invalid");
  });
});

describe("reserved error codes (pinned)", () => {
  test("the four mcplayer codes are exactly -32001..-32004", () => {
    expect(ERR.UNKNOWN_SESSION).toBe(-32001);
    expect(ERR.UNKNOWN_CHANNEL).toBe(-32002);
    expect(ERR.ENGINE_NOT_UP).toBe(-32003);
    expect(ERR.WAL_FULL).toBe(-32004);
  });
});

describe("method param validation (the 5 methods)", () => {
  test("connect requires client_id:string", () => {
    expect(validateParams("mcplayer.connect", { client_id: "c1" }).ok).toBe(
      true,
    );
    expect(validateParams("mcplayer.connect", {}).ok).toBe(false);
    expect(validateParams("mcplayer.connect", { client_id: 5 }).ok).toBe(false);
  });

  test("publish requires channel, message_id, payload; durable optional", () => {
    expect(
      validateParams("mcplayer.publish", {
        channel: "c",
        message_id: "m",
        payload: { a: 1 },
      }).ok,
    ).toBe(true);
    expect(
      validateParams("mcplayer.publish", {
        channel: "c",
        message_id: "m",
        payload: 0,
        durable: true,
      }).ok,
    ).toBe(true);
    expect(
      validateParams("mcplayer.publish", { channel: "c", message_id: "m" }).ok,
    ).toBe(false);
    expect(
      validateParams("mcplayer.publish", { channel: "c", payload: 1 }).ok,
    ).toBe(false);
  });

  test("subscribe requires channel; from_offset optional number", () => {
    expect(validateParams("mcplayer.subscribe", { channel: "c" }).ok).toBe(
      true,
    );
    expect(
      validateParams("mcplayer.subscribe", { channel: "c", from_offset: 7 }).ok,
    ).toBe(true);
    expect(
      validateParams("mcplayer.subscribe", { channel: "c", from_offset: "7" })
        .ok,
    ).toBe(false);
    expect(validateParams("mcplayer.subscribe", {}).ok).toBe(false);
  });

  test("ack requires channel + message_id", () => {
    expect(
      validateParams("mcplayer.ack", { channel: "c", message_id: "m" }).ok,
    ).toBe(true);
    expect(validateParams("mcplayer.ack", { channel: "c" }).ok).toBe(false);
  });

  test("status: engine optional string", () => {
    expect(validateParams("mcplayer.status", {}).ok).toBe(true);
    expect(validateParams("mcplayer.status", { engine: "brainlayer" }).ok).toBe(
      true,
    );
    expect(validateParams("mcplayer.status", { engine: 1 }).ok).toBe(false);
  });

  test("unknown method => not ok", () => {
    expect(validateParams("mcplayer.nope", {}).ok).toBe(false);
  });
});
