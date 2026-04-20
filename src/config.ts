import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface RawServerConfig {
  command?: string;
  cmd?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  strictIsolation?: boolean;
  disabled?: boolean;
  warm?: boolean;
}

export interface ServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  strictIsolation: boolean;
  disabled: boolean;
  warm: boolean;
}

export interface McplayerConfig {
  socketPath: string;
  brainbarSocketPath: string;
  logProject: string;
  logTags: string[];
  logImportance: number;
  servers: Record<string, ServerConfig>;
}

interface RawConfigFile {
  socketPath?: string;
  brainbarSocketPath?: string;
  logProject?: string;
  logTags?: string[];
  logImportance?: number;
  servers?: Record<string, RawServerConfig>;
  mcpServers?: Record<string, RawServerConfig>;
}

const HOME = homedir();
const GITS_DIR = path.join(HOME, "Gits");
const DEFAULT_CONFIG_PATH = path.join(
  HOME,
  "Library",
  "Application Support",
  "mcplayer",
  "config.json",
);

function resolveCommand(binary: string): string {
  return Bun.which(binary) ?? binary;
}

function withDefinedValues(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0),
  );
}

function defaultServers(): Record<string, ServerConfig> {
  return {
    cmuxlayer: {
      command: resolveCommand("bun"),
      args: ["run", path.join(GITS_DIR, "cmuxlayer", "src", "index.ts")],
      env: {},
      strictIsolation: false,
      disabled: false,
      warm: true,
    },
    whatsapp: {
      command: resolveCommand("uv"),
      args: ["run", "--directory", path.join(GITS_DIR, "whatsapp-mcp", "whatsapp-mcp-server"), "main.py"],
      env: {
        WHATSAPP_API_URL: "http://localhost:8741/api",
        WHATSAPP_DB_PATH: path.join(GITS_DIR, "whatsapp-mcp", "whatsapp-bridge", "store", "messages.db"),
      },
      strictIsolation: false,
      disabled: false,
      warm: true,
    },
    "whatsapp-business": {
      command: resolveCommand("uv"),
      args: ["run", "--directory", path.join(GITS_DIR, "whatsapp-mcp", "whatsapp-mcp-server"), "main.py"],
      env: {
        WHATSAPP_API_URL: "http://localhost:8742/api",
        WHATSAPP_DB_PATH: path.join(GITS_DIR, "whatsapp-mcp", "whatsapp-bridge-business", "store", "messages.db"),
      },
      strictIsolation: false,
      disabled: false,
      warm: true,
    },
    "notebooklm-mcp": {
      command: resolveCommand("notebooklm-mcp"),
      args: [],
      env: {},
      strictIsolation: false,
      disabled: false,
      warm: true,
    },
    "israeli-bank-mcp": {
      command: resolveCommand("node"),
      args: [path.join(GITS_DIR, "israeli-bank-mcp", "build", "server.js")],
      env: withDefinedValues({
        PUPPETEER_EXECUTABLE_PATH:
          process.env.PUPPETEER_EXECUTABLE_PATH ??
          "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        LEUMI_USERNAME: process.env.LEUMI_USERNAME,
        LEUMI_PASSWORD: process.env.LEUMI_PASSWORD,
      }),
      strictIsolation: true,
      disabled: false,
      warm: false,
    },
  };
}

function normalizeServer(name: string, server: RawServerConfig): ServerConfig {
  const command = server.command ?? server.cmd;
  if (!command) {
    throw new Error(`mcplayer config server '${name}' is missing 'command'`);
  }

  return {
    command,
    args: Array.isArray(server.args) ? [...server.args] : [],
    env: { ...(server.env ?? {}) },
    cwd: server.cwd,
    strictIsolation: Boolean(server.strictIsolation),
    disabled: Boolean(server.disabled),
    warm: server.warm ?? !server.strictIsolation,
  };
}

export function resolveConfigPath(): string {
  return Bun.env.MCPLAYER_CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
}

export function defaultConfig(): McplayerConfig {
  return {
    socketPath: Bun.env.MCPLAYER_SOCKET_PATH ?? "/tmp/mcplayer.sock",
    brainbarSocketPath: Bun.env.MCPLAYER_BRAINBAR_SOCKET_PATH ?? "/tmp/brainbar.sock",
    logProject: "mcplayer-daemon",
    logTags: ["mcplayer-log", "system"],
    logImportance: 2,
    servers: defaultServers(),
  };
}

export function loadConfig(configPath = resolveConfigPath()): McplayerConfig {
  const defaults = defaultConfig();
  if (!existsSync(configPath)) {
    return defaults;
  }

  let parsed: RawConfigFile;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8")) as RawConfigFile;
  } catch (error) {
    throw new Error(
      `Failed to parse mcplayer config at ${configPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const serverOverrides = parsed.servers ?? parsed.mcpServers;

  return {
    socketPath: parsed.socketPath ?? defaults.socketPath,
    brainbarSocketPath: parsed.brainbarSocketPath ?? defaults.brainbarSocketPath,
    logProject: parsed.logProject ?? defaults.logProject,
    logTags: Array.isArray(parsed.logTags) ? [...parsed.logTags] : defaults.logTags,
    logImportance:
      typeof parsed.logImportance === "number" ? parsed.logImportance : defaults.logImportance,
    servers: serverOverrides
      ? Object.fromEntries(
          Object.entries(serverOverrides).map(([name, server]) => [name, normalizeServer(name, server)]),
        )
      : defaults.servers,
  };
}
