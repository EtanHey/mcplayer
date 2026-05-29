import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EngineState,
  EngineSupervisor,
  createHeartbeatFileHealthProbe,
} from "../../src/server/engine";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("EngineSupervisor", () => {
  test("tracks health through a pluggable probe without blocking state reads", async () => {
    let healthy = false;
    const supervisor = new EngineSupervisor({
      initialState: "building",
      probeIntervalMs: 10,
      healthProbe: async () => healthy,
    });

    supervisor.start();
    expect(supervisor.state().state).toBe("building");

    await wait(25);
    expect(supervisor.state().state).toBe("not-up");

    healthy = true;
    await wait(25);
    expect(supervisor.state().state).toBe("up");

    healthy = false;
    await wait(25);
    expect(supervisor.state().state).toBe("not-up");

    supervisor.stop();
  });

  test("state reads return the last known value while a slow probe is in flight", async () => {
    let resolveProbe: (healthy: boolean) => void = () => {};
    const supervisor = new EngineSupervisor({
      initialState: "building",
      probeIntervalMs: 10,
      healthProbe: () =>
        new Promise<boolean>((resolve) => {
          resolveProbe = resolve;
        }),
    });

    supervisor.start();
    await wait(15);

    const started = performance.now();
    expect(supervisor.state().state).toBe("building");
    expect(performance.now() - started).toBeLessThan(5);

    resolveProbe(true);
    await wait(5);
    expect(supervisor.state().state).toBe("up");

    supervisor.stop();
  });

  test("health probes can return explicit building busy and up states", async () => {
    let probeState: EngineState = "building";
    const supervisor = new EngineSupervisor({
      initialState: "not-up",
      probeIntervalMs: 10,
      healthProbe: () => probeState,
    });

    supervisor.start();
    await wait(15);
    expect(supervisor.state().state).toBe("building");

    probeState = "busy";
    await wait(15);
    expect(supervisor.state().state).toBe("busy");

    probeState = "up";
    await wait(15);
    expect(supervisor.state().state).toBe("up");

    supervisor.stop();
  });

  test("heartbeat file probe reports healthy only while the heartbeat is fresh", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcplayer-engine-test-"));
    const heartbeatPath = join(root, "heartbeat");
    const probe = createHeartbeatFileHealthProbe({
      path: heartbeatPath,
      staleMs: 50,
    });

    expect(probe()).toBe(false);

    writeFileSync(heartbeatPath, String(Date.now()));
    expect(probe()).toBe(true);

    await wait(80);
    expect(probe()).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });

  test("heartbeat file probe reads an explicit engine-state token from a fresh heartbeat", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcplayer-engine-busy-test-"));
    const heartbeatPath = join(root, "heartbeat");
    const probe = createHeartbeatFileHealthProbe({
      path: heartbeatPath,
      staleMs: 1000,
    });

    // A fresh heartbeat carrying a recognized state token reports that state.
    writeFileSync(heartbeatPath, "busy");
    expect(probe()).toBe("busy");

    writeFileSync(heartbeatPath, "building");
    expect(probe()).toBe("building");

    writeFileSync(heartbeatPath, "up");
    expect(probe()).toBe("up");

    // Tokens are trimmed and case-insensitive; an engine can append detail.
    writeFileSync(heartbeatPath, "  BUSY draining 74k backlog\n");
    expect(probe()).toBe("busy");

    // A heartbeat that is just a timestamp (or otherwise tokenless) stays a
    // boolean health signal: fresh => true (up), preserving prior behavior.
    writeFileSync(heartbeatPath, String(Date.now()));
    expect(probe()).toBe(true);

    rmSync(root, { recursive: true, force: true });
  });

  test("engine supervisor surfaces a busy heartbeat as busy and recovers to up", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcplayer-engine-busy-sup-"));
    const heartbeatPath = join(root, "heartbeat");
    writeFileSync(heartbeatPath, "up");
    const supervisor = new EngineSupervisor({
      initialState: "building",
      probeIntervalMs: 10,
      healthProbe: createHeartbeatFileHealthProbe({
        path: heartbeatPath,
        staleMs: 1000,
      }),
    });

    supervisor.start();
    await wait(25);
    expect(supervisor.state().state).toBe("up");

    writeFileSync(heartbeatPath, "busy");
    await wait(25);
    expect(supervisor.state().state).toBe("busy");

    writeFileSync(heartbeatPath, "up");
    await wait(25);
    expect(supervisor.state().state).toBe("up");

    supervisor.stop();
    rmSync(root, { recursive: true, force: true });
  });
});
