import { homedir } from "node:os";
import { join } from "node:path";

import { consumptionOf, listPrices } from "../consumption";
import { defineProvider } from "../provider";
import { readClaudeHistory } from "./anthropic/history";
import { type ClaudeQuery, readClaudeLimits } from "./anthropic/limits";
import { childEnv, type Env, exists, expandHome, which } from "./machine";

export type { AnthropicDetails } from "./anthropic/limits";

export type AnthropicOptions =
  | { readonly apiKey?: undefined; readonly configDir?: string }
  | { readonly apiKey: string; readonly configDir?: undefined };

export type AnthropicCredential =
  | { readonly configDir: string; readonly kind: "login" }
  | { readonly key: string; readonly kind: "api-key" };

export interface AnthropicMachine {
  readonly env?: Env;
  readonly home?: string;
  readonly initTimeoutMs?: number;
  readonly query?: ClaudeQuery;
  readonly usageTimeoutMs?: number;
}

const DEFAULT_INIT_TIMEOUT_MS = 10_000;
const DEFAULT_USAGE_TIMEOUT_MS = 5000;
const FOREIGN_AUTH = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
];

export const createAnthropic = (machine: AnthropicMachine = {}) => {
  const env = machine.env ?? process.env;
  const home = machine.home ?? homedir();
  const homeDir = join(home, ".claude");

  const routedEnv = (configDir: string) =>
    childEnv(
      env,
      FOREIGN_AUTH,
      configDir === homeDir ? {} : { CLAUDE_CONFIG_DIR: configDir }
    );

  const looksUsed = async (configDir: string) =>
    (await exists(join(configDir, ".credentials.json"))) ||
    (await exists(
      configDir === homeDir
        ? join(home, ".claude.json")
        : join(configDir, ".claude.json")
    )) ||
    exists(join(configDir, "projects"));

  const configDirOf = (configDir?: string) =>
    expandHome(configDir ?? (env.CLAUDE_CONFIG_DIR?.trim() || homeDir), home);

  return defineProvider({
    credential: (options: AnthropicOptions): AnthropicCredential => {
      if ("apiKey" in options && !options.apiKey?.trim()) {
        throw new Error("The Anthropic API key given is empty or unset.");
      }
      return options.apiKey === undefined
        ? { configDir: configDirOf(options.configDir), kind: "login" }
        : { key: options.apiKey, kind: "api-key" };
    },
    detect: async () => ((await looksUsed(configDirOf())) ? {} : undefined),
    history: async (credential, since) => {
      if (credential.kind === "api-key") {
        return;
      }
      const works = await readClaudeHistory(credential.configDir, since);
      return consumptionOf(works, since, listPrices("anthropic"), "notional");
    },
    id: "anthropic",
    limits: async (credential) => {
      if (credential.kind === "api-key") {
        return {
          limits: [],
          unsupported: "An Anthropic API key has no limits to read.",
        };
      }
      const childEnvironment = routedEnv(credential.configDir);
      return readClaudeLimits({
        cwd: home,
        env: childEnvironment,
        executable: await which("claude", childEnvironment),
        initTimeoutMs: machine.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS,
        ...(machine.query ? { query: machine.query } : {}),
        usageTimeoutMs: machine.usageTimeoutMs ?? DEFAULT_USAGE_TIMEOUT_MS,
      });
    },
  });
};

export type AnthropicProvider = ReturnType<typeof createAnthropic>;

export const anthropic: AnthropicProvider = createAnthropic();
