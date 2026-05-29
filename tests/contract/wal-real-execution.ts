import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableQueue, WalFullError } from "../../src/wal";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const root = mkdtempSync(join(tmpdir(), "mcplayer-wal-real-"));
const walPath = join(root, "queue.wal");
let proc: ReturnType<typeof Bun.spawn> | undefined;

try {
  console.log(`WAL_REAL temp=${root}`);
  proc = Bun.spawn({
    cmd: ["bun", "run", "tests/contract/wal-kill-writer.ts", walPath],
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });

  const reader = proc.stdout.getReader();
  let readyText = "";
  while (!readyText.includes("WRITER_READY appended=3")) {
    const ready = await reader.read();
    assert(!ready.done, `writer exited before readiness: ${readyText}`);
    const chunk = Buffer.from(ready.value).toString("utf8");
    readyText += chunk;
    process.stdout.write(chunk);
  }
  assert(
    readyText.includes("WRITER_READY appended=3"),
    `writer did not report ready: ${readyText}`,
  );

  proc.kill("SIGKILL");
  const exitCode = await proc.exited;
  console.log(`KILL_SIGNAL signal=SIGKILL exit=${exitCode}`);

  const replay = DurableQueue.open({ path: walPath });
  const replayed = replay.readFrom("jobs", 1);
  console.log(
    `REPLAY_AFTER_KILL count=${replayed.length} ids=${replayed.map((m) => m.message_id).join(",")} offsets=${replayed.map((m) => m.offset).join(",")}`,
  );
  assert(replayed.length === 3, "expected all 3 messages after SIGKILL");
  assert(
    replayed.map((m) => m.message_id).join(",") === "m1,m2,m3",
    "expected FIFO replay after SIGKILL",
  );

  const beforeAck = replay.readFrom("jobs", 1);
  console.log(`AT_LEAST_ONCE_BEFORE_ACK redelivered=${beforeAck.length}`);
  assert(beforeAck.length === 3, "expected redelivery before ack");
  assert(replay.ack("jobs", "m1"), "expected ack m1 to succeed");
  assert(replay.ack("jobs", "m2"), "expected ack m2 to succeed");
  assert(replay.ack("jobs", "m3"), "expected ack m3 to succeed");
  replay.close();

  const afterAck = DurableQueue.open({ path: walPath });
  const afterAckReplay = afterAck.readFrom("jobs", 1);
  console.log(`REPLAY_AFTER_ACK count=${afterAckReplay.length}`);
  assert(afterAckReplay.length === 0, "expected no replay after ack restart");
  afterAck.close();

  const boundedPath = join(root, "bounded.wal");
  const bounded = DurableQueue.open({
    path: boundedPath,
    maxRecordsPerChannel: 1,
  });
  bounded.append("busy", "b1", { kept: true });
  let rejected = false;
  try {
    bounded.append("busy", "b2", { rejected: true });
  } catch (error) {
    rejected = error instanceof WalFullError;
    console.log(
      `BOUNDED_REJECTION error=${error instanceof Error ? error.name : typeof error} code=${error instanceof WalFullError ? error.code : "n/a"}`,
    );
  }
  assert(rejected, "expected bounded WAL to reject with WalFullError");
  const kept = bounded.readFrom("busy", 1);
  console.log(
    `BOUNDED_NO_DROP count=${kept.length} ids=${kept.map((m) => m.message_id).join(",")}`,
  );
  assert(
    kept.length === 1 && kept[0].message_id === "b1",
    "expected bounded WAL to keep old message and reject new one",
  );
  bounded.close();

  console.log("WAL_REAL_EXECUTION_OK");
} finally {
  try {
    proc?.kill("SIGKILL");
  } catch {
    // The writer may already be dead after the intentional SIGKILL.
  }
  rmSync(root, { recursive: true, force: true });
}
