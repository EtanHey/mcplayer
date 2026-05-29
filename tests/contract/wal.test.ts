import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeLine } from "../../src/protocol";
import { DurableQueue, WalFullError } from "../../src/wal";

const tempRoots: string[] = [];

function tempWalPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "mcplayer-wal-test-"));
  tempRoots.push(dir);
  return join(dir, "queue.wal");
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe("DurableQueue WAL", () => {
  test("reopens unacked messages in per-channel FIFO order with monotonic offsets", () => {
    const path = tempWalPath();
    const q = DurableQueue.open({ path });

    expect(q.append("jobs", "m1", { n: 1 })).toEqual({ offset: 1 });
    expect(q.append("jobs", "m2", { n: 2 })).toEqual({ offset: 2 });
    expect(q.append("alerts", "a1", { ok: true })).toEqual({ offset: 1 });
    q.close();

    const reopened = DurableQueue.open({ path });
    expect(reopened.readFrom("jobs", 1)).toEqual([
      { channel: "jobs", message_id: "m1", payload: { n: 1 }, offset: 1 },
      { channel: "jobs", message_id: "m2", payload: { n: 2 }, offset: 2 },
    ]);
    expect(reopened.readFrom("alerts", 1)).toEqual([
      { channel: "alerts", message_id: "a1", payload: { ok: true }, offset: 1 },
    ]);
    reopened.close();
  });

  test("readFrom resumes inclusively from an offset", () => {
    const q = DurableQueue.open({ path: tempWalPath() });
    q.append("jobs", "m1", { n: 1 });
    q.append("jobs", "m2", { n: 2 });
    q.append("jobs", "m3", { n: 3 });

    expect(q.readFrom("jobs", 2).map((m) => m.message_id)).toEqual([
      "m2",
      "m3",
    ]);
    q.close();
  });

  test("append is idempotent per channel and message_id", () => {
    const q = DurableQueue.open({ path: tempWalPath() });

    expect(q.append("jobs", "same", { first: true })).toEqual({ offset: 1 });
    expect(q.append("jobs", "same", { first: false })).toEqual({ offset: 1 });
    expect(q.readFrom("jobs", 1)).toEqual([
      {
        channel: "jobs",
        message_id: "same",
        payload: { first: true },
        offset: 1,
      },
    ]);
    q.close();
  });

  test("unacked messages replay after restart, then ack removes them from later replay", () => {
    const path = tempWalPath();
    const q = DurableQueue.open({ path });
    q.append("jobs", "m1", { task: "persist" });
    q.close();

    const replay = DurableQueue.open({ path });
    expect(replay.readFrom("jobs", 1).map((m) => m.message_id)).toEqual(["m1"]);
    expect(replay.ack("jobs", "m1")).toBe(true);
    replay.close();

    const afterAck = DurableQueue.open({ path });
    expect(afterAck.readFrom("jobs", 1)).toEqual([]);
    expect(afterAck.ack("jobs", "missing")).toBe(false);
    afterAck.close();
  });

  test("bounded WAL rejects with WalFullError and does not drop old messages", () => {
    const q = DurableQueue.open({ path: tempWalPath(), maxRecordsPerChannel: 2 });
    q.append("jobs", "m1", { n: 1 });
    q.append("jobs", "m2", { n: 2 });

    expect(() => q.append("jobs", "m3", { n: 3 })).toThrow(WalFullError);
    expect(q.readFrom("jobs", 1).map((m) => m.message_id)).toEqual([
      "m1",
      "m2",
    ]);
    q.close();
  });

  test("byte cap allows an append that exactly reaches the cap", () => {
    const path = tempWalPath();
    const entry = {
      v: 1,
      type: "append",
      channel: "jobs",
      message_id: "m1",
      payload: { n: 1 },
      offset: 1,
    };
    const exactBytes = Buffer.byteLength(encodeLine(entry), "utf8");
    const q = DurableQueue.open({ path, maxBytesPerChannel: exactBytes });

    expect(q.append("jobs", "m1", { n: 1 })).toEqual({ offset: 1 });
    expect(() => q.append("jobs", "m2", { n: 2 })).toThrow(WalFullError);
    q.close();
  });

  test("open ignores a trailing partial WAL line left by a crash", () => {
    const path = tempWalPath();
    writeFileSync(
      path,
      [
        JSON.stringify({
          v: 1,
          type: "append",
          channel: "jobs",
          message_id: "m1",
          payload: { n: 1 },
          offset: 1,
        }),
        '{"v":1,"type":"append","channel":"jobs"',
      ].join("\n"),
    );

    const q = DurableQueue.open({ path });
    expect(q.readFrom("jobs", 1)).toEqual([
      { channel: "jobs", message_id: "m1", payload: { n: 1 }, offset: 1 },
    ]);
    q.close();
  });

  test("open skips malformed completed WAL entries without losing valid entries", () => {
    const path = tempWalPath();
    writeFileSync(
      path,
      [
        JSON.stringify({
          v: 1,
          type: "append",
          channel: "jobs",
          message_id: "m1",
          payload: { n: 1 },
          offset: 1,
        }),
        JSON.stringify({
          v: 1,
          type: "append",
          channel: "jobs",
          message_id: "bad",
          payload: { n: 999 },
        }),
        JSON.stringify({
          v: 1,
          type: "append",
          channel: "jobs",
          message_id: "m2",
          payload: { n: 2 },
          offset: 2,
        }),
        "",
      ].join("\n"),
    );

    const q = DurableQueue.open({ path });
    expect(q.readFrom("jobs", 1).map((m) => m.message_id)).toEqual([
      "m1",
      "m2",
    ]);
    q.close();
  });
});
