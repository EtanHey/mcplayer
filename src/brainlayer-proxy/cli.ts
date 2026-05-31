#!/usr/bin/env bun

import { BrainlayerProxy, type BrainlayerProxyOptions, type UpstreamTarget } from ".";

const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_DEGRADED_MS = 5000;

export function parseUpstreamTarget(value: string): UpstreamTarget {
  if (!value)
    throw new Error(
      "MCPLAYER_BRAINLAYER_UPSTREAM is required; expected unix:<path> or tcp:<host>:<port>",
    );
  if (value.startsWith("unix:")) {
    const path = value.slice("unix:".length);
    if (!path)
      throw new Error(
        "invalid MCPLAYER_BRAINLAYER_UPSTREAM: expected unix:<path>",
      );
    return { kind: "unix", path };
  }
  if (value.startsWith("tcp:")) {
    const rest = value.slice("tcp:".length);
    const idx = rest.lastIndexOf(":");
    if (idx <= 0 || idx === rest.length - 1)
      throw new Error(
        "invalid MCPLAYER_BRAINLAYER_UPSTREAM: expected unix:<path> or tcp:<host>:<port>",
      );
    const host = rest.slice(0, idx);
    const port = Number(rest.slice(idx + 1));
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error(
        `invalid tcp port in MCPLAYER_BRAINLAYER_UPSTREAM: ${rest.slice(idx + 1)}`,
      );
    return { kind: "tcp", host, port };
  }
  throw new Error(
    "invalid MCPLAYER_BRAINLAYER_UPSTREAM: expected unix:<path> or tcp:<host>:<port>",
  );
}

export function formatUpstreamTarget(target: UpstreamTarget): string {
  return target.kind === "unix"
    ? `unix:${target.path}`
    : `tcp:${target.host}:${target.port}`;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function brainlayerProxyConfigFromEnv(
  env: Record<string, string | undefined>,
): BrainlayerProxyOptions {
  return {
    frontSocketPath:
      env.MCPLAYER_BRAINLAYER_FRONT ?? "/tmp/mcplayer-brainlayer.sock",
    upstream: parseUpstreamTarget(
      env.MCPLAYER_BRAINLAYER_UPSTREAM ?? "unix:/tmp/brainbar.sock",
    ),
    requestTimeoutMs: parsePositiveInt(
      env.MCPLAYER_BRAINLAYER_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
    ),
    degradedMs: parsePositiveInt(
      env.MCPLAYER_BRAINLAYER_DEGRADED_MS,
      DEFAULT_DEGRADED_MS,
    ),
  };
}

interface ShutdownProxy {
  shutdown(): Promise<void>;
}

interface ShutdownHooks {
  exit(code: number): void;
  error(line: string): void;
}

export async function shutdownBrainlayerProxyDaemon(
  proxy: ShutdownProxy,
  hooks: ShutdownHooks = {
    exit: (code) => process.exit(code),
    error: (line) => console.error(line),
  },
): Promise<void> {
  try {
    await proxy.shutdown();
    hooks.exit(0);
  } catch (err) {
    hooks.error(
      `BRAINLAYER_PROXY_SHUTDOWN_ERROR ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    hooks.exit(1);
  }
}

export async function runBrainlayerProxyDaemon(
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const config = brainlayerProxyConfigFromEnv(env);
  const proxy = new BrainlayerProxy(config);
  await proxy.start();
  const upstream = formatUpstreamTarget(config.upstream);
  console.log(
    `BRAINLAYER_PROXY_LISTENING front=${config.frontSocketPath} upstream=${upstream}`,
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownBrainlayerProxyDaemon(proxy);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

if (import.meta.main) {
  runBrainlayerProxyDaemon().catch((err) => {
    console.error(
      `BRAINLAYER_PROXY_FATAL ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  });
}
