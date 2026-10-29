import { homedir } from "node:os";
import { join } from "node:path";

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";

import { consumptionOf, listPrices } from "../../consumption";
import { defineProvider } from "../../provider";
import { childEnv, type Env, exists, expandHome, which } from "../local";
import { readClaudeHistory } from "./history";
import { type ClaudeQuery, readClaudeLimits } from "./limits";

/**
 * A Claude Code login by its config dir, the directory `CLAUDE_CONFIG_DIR`
 * would name (`~` allowed; by default the one Claude Code uses here), or an
 * Anthropic API key, such as `process.env.ANTHROPIC_API_KEY`.
 */
export type AnthropicOptions =
  | { readonly apiKey?: undefined; readonly configDir?: string }
  | { readonly apiKey: string; readonly configDir?: undefined };

export type AnthropicCredential =
  /** `configDir` is absolute; Claude Code runs with it as `CLAUDE_CONFIG_DIR`. */
  | { readonly configDir: string; readonly kind: "login" }
  | { readonly key: string; readonly kind: "api-key" };

/** What a test replaces: this machine, and the Agent SDK. */
export interface AnthropicMachine {
  readonly env?: Env;
  readonly home?: string;
  readonly initTimeoutMs?: number;
  readonly query?: ClaudeQuery;
  readonly usageTimeoutMs?: number;
}

const DEFAULT_INIT_TIMEOUT_MS = 10_000;
const DEFAULT_USAGE_TIMEOUT_MS = 5000;
/** Removed from a login's environment so it reads its own login, not a key or token. */
const FOREIGN_AUTH = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
];

/** An Anthropic provider over this machine, or over what `machine` replaces. */
export const createAnthropic = (machine: AnthropicMachine = {}) => {
  const env = machine.env ?? process.env;
  const home = machine.home ?? homedir();
  const homeDir = join(home, ".claude");

  /**
   * Claude Code keeps the default login's account file at `~/.claude.json`
   * and any other's inside its dir; with `CLAUDE_CONFIG_DIR=~/.claude` it
   * looks inside the dir and reads as signed out. So `CLAUDE_CONFIG_DIR` is
   * set only for a login that is not the default, and an inherited one is
   * always removed.
   */
  const routedEnv = (configDir: string) =>
    childEnv(
      env,
      FOREIGN_AUTH,
      configDir === homeDir ? {} : { CLAUDE_CONFIG_DIR: configDir }
    );

  /** Presence only: the credentials file, or the account file a login writes. */
  const looksSignedIn = async (configDir: string) =>
    (await exists(join(configDir, ".credentials.json"))) ||
    exists(
      configDir === homeDir
        ? join(home, ".claude.json")
        : join(configDir, ".claude.json")
    );

  const configDirOf = (configDir?: string) =>
    expandHome(configDir ?? (env.CLAUDE_CONFIG_DIR?.trim() || homeDir), home);

  return defineProvider({
    credential: (options: AnthropicOptions): AnthropicCredential => {
      // An unset key never falls back to the default login under another name.
      if ("apiKey" in options && !options.apiKey?.trim()) {
        throw new Error("The Anthropic API key given is empty or unset.");
      }
      return options.apiKey === undefined
        ? { configDir: configDirOf(options.configDir), kind: "login" }
        : { key: options.apiKey, kind: "api-key" };
    },
    detect: async () => ((await looksSignedIn(configDirOf())) ? {} : undefined),
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
        // Not a project directory, so no project config is read.
        cwd: home,
        env: childEnvironment,
        executable: await which("claude", childEnvironment),
        initTimeoutMs: machine.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS,
        query: machine.query ?? sdkQuery,
        usageTimeoutMs: machine.usageTimeoutMs ?? DEFAULT_USAGE_TIMEOUT_MS,
      });
    },
  });
};

export type AnthropicProvider = ReturnType<typeof createAnthropic>;
