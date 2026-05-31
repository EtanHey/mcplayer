import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  brainlayerProxyConfigFromEnv,
  formatUpstreamTarget,
  parseUpstreamTarget,
  shutdownBrainlayerProxyDaemon,
} from "../../src/brainlayer-proxy/cli";

describe("BrainLayer proxy daemon CLI config", () => {
  test("parses unix and tcp upstream targets", () => {
    expect(parseUpstreamTarget("unix:/tmp/brainbar.sock")).toEqual({
      kind: "unix",
      path: "/tmp/brainbar.sock",
    });
    expect(parseUpstreamTarget("tcp:127.0.0.1:3999")).toEqual({
      kind: "tcp",
      host: "127.0.0.1",
      port: 3999,
    });
    expect(formatUpstreamTarget({ kind: "unix", path: "/tmp/brainbar.sock" }))
      .toBe("unix:/tmp/brainbar.sock");
    expect(formatUpstreamTarget({ kind: "tcp", host: "127.0.0.1", port: 3999 }))
      .toBe("tcp:127.0.0.1:3999");
  });

  test("rejects malformed upstream targets loudly", () => {
    expect(() => parseUpstreamTarget("")).toThrow("MCPLAYER_BRAINLAYER_UPSTREAM");
    expect(() => parseUpstreamTarget("brainbar:/tmp/brainbar.sock")).toThrow(
      "expected unix:<path> or tcp:<host>:<port>",
    );
    expect(() => parseUpstreamTarget("tcp:127.0.0.1:not-a-port")).toThrow(
      "invalid tcp port",
    );
  });

  test("builds daemon config from env with safe defaults", () => {
    expect(brainlayerProxyConfigFromEnv({})).toEqual({
      frontSocketPath: "/tmp/mcplayer-brainlayer.sock",
      upstream: { kind: "unix", path: "/tmp/brainbar.sock" },
      requestTimeoutMs: 15000,
      degradedMs: 5000,
    });
    expect(
      brainlayerProxyConfigFromEnv({
        MCPLAYER_BRAINLAYER_FRONT: "/tmp/test-front.sock",
        MCPLAYER_BRAINLAYER_UPSTREAM: "tcp:localhost:5555",
      }),
    ).toEqual({
      frontSocketPath: "/tmp/test-front.sock",
      upstream: { kind: "tcp", host: "localhost", port: 5555 },
      requestTimeoutMs: 15000,
      degradedMs: 5000,
    });
  });

  test("wires P1b timeout env vars into daemon config with default fallbacks", () => {
    expect(
      brainlayerProxyConfigFromEnv({
        MCPLAYER_BRAINLAYER_REQUEST_TIMEOUT_MS: "3210",
        MCPLAYER_BRAINLAYER_DEGRADED_MS: "432",
      }),
    ).toMatchObject({
      requestTimeoutMs: 3210,
      degradedMs: 432,
    });

    expect(
      brainlayerProxyConfigFromEnv({
        MCPLAYER_BRAINLAYER_REQUEST_TIMEOUT_MS: "not-a-number",
        MCPLAYER_BRAINLAYER_DEGRADED_MS: "0",
      }),
    ).toMatchObject({
      requestTimeoutMs: 15000,
      degradedMs: 5000,
    });
  });

  test("bin entrypoint starts the proxy and logs the listening marker", async () => {
    const root = mkdtempSync(join(tmpdir(), "blp-cli-"));
    const frontPath = join(root, "front.sock");
    const upstreamPath = join(root, "upstream.sock");
    const proc = Bun.spawn({
      cmd: [process.execPath, "bin/mcplayer-brainlayer-proxy"],
      env: {
        ...process.env,
        MCPLAYER_BRAINLAYER_FRONT: frontPath,
        MCPLAYER_BRAINLAYER_UPSTREAM: `unix:${upstreamPath}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const reader = proc.stdout.getReader();
      const output = await Promise.race([
        reader.read().then((chunk) =>
          new TextDecoder().decode(chunk.value ?? new Uint8Array()),
        ),
        new Promise<string>((_, reject) =>
          setTimeout(
            () => reject(new Error("timed out waiting for listening marker")),
            1000,
          ),
        ),
      ]);
      expect(output).toContain("BRAINLAYER_PROXY_LISTENING");
      expect(output).toContain(`front=${frontPath}`);
      expect(output).toContain(`upstream=unix:${upstreamPath}`);
    } finally {
      proc.kill("SIGTERM");
      await proc.exited;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("shutdown exits non-zero when proxy shutdown rejects", async () => {
    const exits: number[] = [];
    const errors: string[] = [];
    await shutdownBrainlayerProxyDaemon(
      {
        shutdown: async () => {
          throw new Error("shutdown rejected");
        },
      },
      {
        exit: (code) => exits.push(code),
        error: (line) => errors.push(line),
      },
    );

    expect(exits).toEqual([1]);
    expect(errors.join("\n")).toContain("BRAINLAYER_PROXY_SHUTDOWN_ERROR");
    expect(errors.join("\n")).toContain("shutdown rejected");
  });
});
