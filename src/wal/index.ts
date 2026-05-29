import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { encodeLine } from "../protocol";

export interface WalRecord {
  channel: string;
  message_id: string;
  payload: unknown;
  offset: number;
}

export interface DurableQueueOptions {
  path: string;
  maxBytesPerChannel?: number;
  maxRecordsPerChannel?: number;
}

type AppendWalEntry = {
  v: 1;
  type: "append";
  channel: string;
  message_id: string;
  payload: unknown;
  offset: number;
};

type AckWalEntry = {
  v: 1;
  type: "ack";
  channel: string;
  message_id: string;
};

type WalEntry = AppendWalEntry | AckWalEntry;

type ChannelState = {
  records: WalRecord[];
  byMessageId: Map<string, WalRecord>;
  nextOffset: number;
  liveBytes: number;
};

export class WalFullError extends Error {
  readonly code = "WAL_FULL";
  readonly channel: string;

  constructor(channel: string, message: string) {
    super(message);
    this.name = "WalFullError";
    this.channel = channel;
  }
}

export class DurableQueue {
  readonly #path: string;
  readonly #maxBytesPerChannel?: number;
  readonly #maxRecordsPerChannel?: number;
  readonly #channels = new Map<string, ChannelState>();
  #fd: number;
  #closed = false;

  private constructor(opts: DurableQueueOptions) {
    this.#path = opts.path;
    this.#maxBytesPerChannel = opts.maxBytesPerChannel;
    this.#maxRecordsPerChannel = opts.maxRecordsPerChannel;

    mkdirSync(dirname(this.#path), { recursive: true });
    this.#replay();
    this.#fd = openSync(this.#path, "a");
  }

  static open(opts: DurableQueueOptions): DurableQueue {
    return new DurableQueue(opts);
  }

  append(
    channel: string,
    message_id: string,
    payload: unknown,
  ): { offset: number } {
    this.#assertOpen();
    const state = this.#state(channel);
    const existing = state.byMessageId.get(message_id);
    if (existing) return { offset: existing.offset };

    const record: WalRecord = {
      channel,
      message_id,
      payload,
      offset: state.nextOffset,
    };
    const entry: AppendWalEntry = { v: 1, type: "append", ...record };
    const entryBytes = Buffer.byteLength(encodeLine(entry), "utf8");
    this.#assertCapacity(channel, state, entryBytes);

    this.#writeEntry(entry);
    this.#addRecord(state, record, entryBytes);
    return { offset: record.offset };
  }

  readFrom(channel: string, fromOffset: number): WalRecord[] {
    this.#assertOpen();
    return this.#state(channel)
      .records.filter((record) => record.offset >= fromOffset)
      .map((record) => ({ ...record }));
  }

  ack(channel: string, message_id: string): boolean {
    this.#assertOpen();
    const state = this.#state(channel);
    const existing = state.byMessageId.get(message_id);
    if (!existing) return false;

    this.#writeEntry({ v: 1, type: "ack", channel, message_id });
    this.#removeRecord(state, message_id);
    return true;
  }

  close(): void {
    if (this.#closed) return;
    fsyncSync(this.#fd);
    closeSync(this.#fd);
    this.#closed = true;
  }

  #replay(): void {
    if (!existsSync(this.#path)) return;

    const text = readFileSync(this.#path, "utf8");
    const lines = text.split("\n");
    const hasTrailingNewline = text.endsWith("\n");
    for (const [index, line] of lines.entries()) {
      if (line.trim().length === 0) continue;
      let entry: WalEntry;
      try {
        entry = JSON.parse(line) as WalEntry;
      } catch (error) {
        const isTrailingPartial =
          !hasTrailingNewline && index === lines.length - 1;
        if (isTrailingPartial) break;
        throw error;
      }
      if (entry.v !== 1) continue;

      if (entry.type === "append") {
        if (!isValidAppendEntry(entry)) continue;
        const state = this.#state(entry.channel);
        if (state.byMessageId.has(entry.message_id)) continue;
        this.#addRecord(
          state,
          {
            channel: entry.channel,
            message_id: entry.message_id,
            payload: entry.payload,
            offset: entry.offset,
          },
          Buffer.byteLength(encodeLine(entry), "utf8"),
        );
      } else if (isValidAckEntry(entry)) {
        const state = this.#state(entry.channel);
        this.#removeRecord(state, entry.message_id);
      }
    }
  }

  #state(channel: string): ChannelState {
    let state = this.#channels.get(channel);
    if (!state) {
      state = {
        records: [],
        byMessageId: new Map(),
        nextOffset: 1,
        liveBytes: 0,
      };
      this.#channels.set(channel, state);
    }
    return state;
  }

  #assertCapacity(
    channel: string,
    state: ChannelState,
    nextEntryBytes: number,
  ): void {
    if (
      this.#maxRecordsPerChannel !== undefined &&
      state.records.length >= this.#maxRecordsPerChannel
    ) {
      throw new WalFullError(
        channel,
        `WAL full for channel ${channel}: record limit ${this.#maxRecordsPerChannel} reached`,
      );
    }
    if (
      this.#maxBytesPerChannel !== undefined &&
      state.liveBytes + nextEntryBytes > this.#maxBytesPerChannel
    ) {
      throw new WalFullError(
        channel,
        `WAL full for channel ${channel}: byte limit ${this.#maxBytesPerChannel} would be exceeded`,
      );
    }
  }

  #addRecord(state: ChannelState, record: WalRecord, entryBytes: number): void {
    state.records.push(record);
    state.byMessageId.set(record.message_id, record);
    state.nextOffset = Math.max(state.nextOffset, record.offset + 1);
    state.liveBytes += entryBytes;
  }

  #removeRecord(state: ChannelState, message_id: string): void {
    const record = state.byMessageId.get(message_id);
    if (!record) return;
    const entry: AppendWalEntry = { v: 1, type: "append", ...record };
    state.liveBytes -= Buffer.byteLength(encodeLine(entry), "utf8");
    state.byMessageId.delete(message_id);
    state.records = state.records.filter((r) => r.message_id !== message_id);
  }

  #writeEntry(entry: WalEntry): void {
    writeSync(this.#fd, encodeLine(entry), undefined, "utf8");
    fsyncSync(this.#fd);
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("DurableQueue is closed");
    }
  }
}

function isValidAppendEntry(entry: WalEntry): entry is AppendWalEntry {
  return (
    entry.type === "append" &&
    typeof entry.channel === "string" &&
    typeof entry.message_id === "string" &&
    typeof entry.offset === "number" &&
    Number.isFinite(entry.offset)
  );
}

function isValidAckEntry(entry: WalEntry): entry is AckWalEntry {
  return (
    entry.type === "ack" &&
    typeof entry.channel === "string" &&
    typeof entry.message_id === "string"
  );
}
