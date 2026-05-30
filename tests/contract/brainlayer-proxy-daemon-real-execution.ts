// Real-execution proof for the BrainLayer proxy LaunchAgent (P1a).
//
// This drives real launchd with an isolated label, temp front socket, and temp
// fake upstream. It never touches com.mcplayer.brainlayer-proxy, the canonical
// /tmp/mcplayer-brainlayer.sock, /tmp/brainbar.sock, or BrainBarD.
//
// Required marker:
//   BRAINLAYER_PROXY_DAEMON_OK keepalive_restart=1 front_socket=stable

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeLine, NdjsonDecoder } from "../../src/protocol";

type JsonRpcMessage = Record<string, unknown>;

const uid = process.getuid?.() ?? 0;
const domain = `gui/${uid}`;
const label = `com.mcplayer.brainlayer-proxy.proof.${process.pid}`;
const root = mkdtempSync(join(tmpdir(), "blp-daemon-proof-"));
const frontPath = join(root, "front.sock");
const upstreamPath = join(root, "upstream.sock");
const plistPath = join(root, `${label}.plist`);
const repoRoot = process.cwd();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function launchctl(...args: string[]): Promise<{ code: number; out: string }> {
  const child = Bun.spawn({
    cmd: ["launchctl", ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = `${await new Response(child.stdout).text()}${await new Response(child.stderr).text()}`;
  const code = await child.exited;
  return { code, out };
}

async function daemonPid(): Promise<number> {
  const { out } = await launchctl("list", label);
  const match = out.match(/"PID"\s*=\s*(\d+)/);
  return match ? Number(match[1]) : 0;
}

async function waitForPid(
  predicate: (pid: number) => boolean,
  labelText: string,
): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    const pid = await daemonPid();
    if (predicate(pid)) return pid;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${labelText}`);
}

function startFakeUpstream(): Promise<net.Server> {
  const server = net.createServer((sock) => {
    const decoder = new NdjsonDecoder();
    sock.on("data", (chunk) => {
      for (const msg of decoder.push(chunk) as JsonRpcMessage[]) {
        if (msg.method === undefined) continue;
        sock.write(
          encodeLine({
            jsonrpc: "2.0",
            id: msg.id,
            result: { ok: true, daemonProof: true, method: msg.method },
          }),
        );
      }
    });
  });
  return new Promise((resolve) => server.listen(upstreamPath, () => resolve(server)));
}

async function requestThroughProxy(id: number): Promise<JsonRpcMessage> {
  const sock = net.createConnection(frontPath);
  const decoder = new NdjsonDecoder();
  const response = new Promise<JsonRpcMessage>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for proxy response ${id}`)),
      2000,
    );
    sock.on("data", (chunk) => {
      for (const msg of decoder.push(chunk) as JsonRpcMessage[]) {
        if (msg.id === id) {
          clearTimeout(timer);
          resolve(msg);
        }
      }
    });
    sock.once("error", reject);
  });
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", resolve);
    sock.once("error", reject);
  });
  sock.write(encodeLine({ jsonrpc: "2.0", id, method: "brain_daemon_proof" }));
  try {
    return await response;
  } finally {
    sock.destroy();
  }
}

async function waitForProxyResponse(id: number): Promise<JsonRpcMessage> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < 15000) {
    if (!existsSync(frontPath)) {
      await sleep(100);
      continue;
    }
    try {
      return await requestThroughProxy(id);
    } catch (err) {
      lastError = err;
      await sleep(100);
    }
  }
  throw new Error(`timed out waiting for proxy response: ${lastError}`);
}

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${join(repoRoot, "bin/mcplayer-brainlayer-proxy")}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>1</integer>
  <key>StandardOutPath</key><string>${join(root, "proxy.log")}</string>
  <key>StandardErrorPath</key><string>${join(root, "proxy.err")}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${process.env.PATH ?? ""}</string>
    <key>MCPLAYER_BRAINLAYER_FRONT</key><string>${frontPath}</string>
    <key>MCPLAYER_BRAINLAYER_UPSTREAM</key><string>unix:${upstreamPath}</string>
  </dict>
</dict>
</plist>
`;

let upstream: net.Server | undefined;
try {
  upstream = await startFakeUpstream();
  writeFileSync(plistPath, plist);

  await launchctl("bootout", `${domain}/${label}`);
  const boot = await launchctl("bootstrap", domain, plistPath);
  assert(boot.code === 0, `bootstrap failed: ${boot.out}`);

  const pid1 = await waitForPid((pid) => pid > 0, "initial proxy pid");
  const before = await waitForProxyResponse(1);
  assert((before.result as { daemonProof?: boolean }).daemonProof, "proxy did not relay before crash");
  console.log(`BRAINLAYER_PROXY_DAEMON_BOOTSTRAPPED label=${label} pid=${pid1}`);

  process.kill(pid1, "SIGKILL");
  console.log(`SENT_SIGKILL pid=${pid1}`);

  const pid2 = await waitForPid(
    (pid) => pid > 0 && pid !== pid1,
    "respawned proxy pid",
  );
  const after = await waitForProxyResponse(2);
  assert((after.result as { daemonProof?: boolean }).daemonProof, "proxy did not relay after respawn");
  console.log(`BRAINLAYER_PROXY_DAEMON_RESPAWNED old_pid=${pid1} new_pid=${pid2}`);
  console.log(
    "BRAINLAYER_PROXY_DAEMON_OK keepalive_restart=1 front_socket=stable",
  );
} finally {
  await launchctl("bootout", `${domain}/${label}`);
  await new Promise<void>((resolve) => upstream?.close(() => resolve()) ?? resolve());
  rmSync(root, { recursive: true, force: true });
}
