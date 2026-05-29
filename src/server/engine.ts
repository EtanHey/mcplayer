import { readFileSync, statSync } from "node:fs";

export type EngineState = "up" | "busy" | "building" | "not-up";

export interface EngineStatus {
  state: EngineState;
  since: string;
}

export type EngineHealthProbeResult = boolean | EngineState;
export type EngineHealthProbe = () =>
  | EngineHealthProbeResult
  | Promise<EngineHealthProbeResult>;
export type EngineStateListener = (status: EngineStatus) => void;

export interface EngineSupervisorOptions {
  initialState?: EngineState;
  healthProbe?: EngineHealthProbe;
  probeIntervalMs?: number;
}

export interface HeartbeatFileHealthProbeOptions {
  path: string;
  staleMs: number;
}

export class EngineSupervisor {
  readonly #healthProbe?: EngineHealthProbe;
  readonly #probeIntervalMs: number;
  readonly #listeners = new Set<EngineStateListener>();
  #status: EngineStatus;
  #timer?: ReturnType<typeof setInterval>;
  #probeRunning = false;

  constructor(opts: EngineSupervisorOptions = {}) {
    this.#healthProbe = opts.healthProbe;
    this.#probeIntervalMs = opts.probeIntervalMs ?? 1000;
    this.#status = {
      state: opts.initialState ?? "not-up",
      since: new Date().toISOString(),
    };
  }

  state(): EngineStatus {
    return { ...this.#status };
  }

  start(): void {
    if (!this.#healthProbe || this.#timer) return;
    void this.#runProbe();
    this.#timer = setInterval(
      () => void this.#runProbe(),
      this.#probeIntervalMs,
    );
    this.#timer.unref?.();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  onStateChange(listener: EngineStateListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  markBuilding(): void {
    this.#setState("building");
  }

  markUp(): void {
    this.#setState("up");
  }

  markBusy(): void {
    this.#setState("busy");
  }

  markDown(): void {
    this.#setState("not-up");
  }

  async #runProbe(): Promise<void> {
    if (!this.#healthProbe || this.#probeRunning) return;
    this.#probeRunning = true;
    try {
      this.#setState(probeResultToState(await this.#healthProbe()));
    } catch {
      this.#setState("not-up");
    } finally {
      this.#probeRunning = false;
    }
  }

  #setState(state: EngineState): void {
    if (this.#status.state === state) return;
    this.#status = { state, since: new Date().toISOString() };
    for (const listener of this.#listeners) {
      listener(this.state());
    }
  }
}

export function createHeartbeatFileHealthProbe(
  opts: HeartbeatFileHealthProbeOptions,
): EngineHealthProbe {
  return () => {
    let fresh: boolean;
    try {
      fresh = Date.now() - statSync(opts.path).mtimeMs <= opts.staleMs;
    } catch {
      return false;
    }
    if (!fresh) return false;
    // A fresh heartbeat that carries a recognized engine-state token lets the
    // engine declare "busy"/"building"/"up"/"not-up" directly (e.g. signal
    // backpressure so clients back off instead of hammering an overloaded
    // engine). A tokenless heartbeat (a timestamp or empty) stays a pure
    // freshness signal: fresh => true (up).
    return readHeartbeatStateToken(opts.path) ?? true;
  };
}

function readHeartbeatStateToken(path: string): EngineState | undefined {
  let token: string;
  try {
    token =
      readFileSync(path, "utf8").trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  } catch {
    return undefined;
  }
  switch (token) {
    case "up":
    case "busy":
    case "building":
    case "not-up":
      return token;
    default:
      return undefined;
  }
}

function probeResultToState(result: EngineHealthProbeResult): EngineState {
  return typeof result === "boolean" ? (result ? "up" : "not-up") : result;
}
