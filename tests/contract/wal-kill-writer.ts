import { DurableQueue } from "../../src/wal";

const path = process.argv[2];
if (!path) {
  console.error("missing wal path");
  process.exit(2);
}

const q = DurableQueue.open({ path });
q.append("jobs", "m1", { body: "first" });
q.append("jobs", "m2", { body: "second" });
q.append("jobs", "m3", { body: "third" });
console.log("WRITER_READY appended=3 fsync=append");

setInterval(() => {
  // Keep the process alive so the parent can prove SIGKILL recovery.
}, 1000);
