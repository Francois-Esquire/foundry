import { homedir } from "node:os";
import { join } from "node:path";

import {
  consumptionOf,
  type ListPricesOptions,
  listPrices,
} from "../consumption";
import { defineProvider } from "../provider";
import { readClaudeHistory } from "./anthropic/history";
import { type ClaudeQuery, readClaudeLimits } from "./anthropic/limits";
import { childEnv, type Env, exists, expandHome, which } from "./machine";

export type { AnthropicDetails } from "./anthropic/limits";

export type AnthropicOptions =
  | { readonly apiKey?: undefined; readonly configDir?: string }
  | { readonly apiKey: string; readonly configDir?: undefined };

type AnthropicCredential =
  | { readonly configDir: string; readonly kind: "login" }
  | { readonly kind: "api-key" };

export interface AnthropicMachine {
  readonly catalog?: ListPricesOptions["catalog"];
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
  const envOf = () => machine.env ?? process.env;
  const homeOf = () => machine.home ?? homedir();
  const claudeDirOf = (home = homeOf()) => join(home, ".claude");

  const routedEnv = (configDir: string) =>
    childEnv(
      envOf(),
      FOREIGN_AUTH,
      configDir === claudeDirOf() ? {} : { CLAUDE_CONFIG_DIR: configDir }
    );

  const looksUsed = async (configDir: string) => {
    const home = homeOf();
    return (
      (await exists(join(configDir, ".credentials.json"))) ||
      (await exists(
        configDir === claudeDirOf(home)
          ? join(home, ".claude.json")
          : join(configDir, ".claude.json")
      )) ||
      exists(join(configDir, "projects"))
    );
  };

  const configDirOf = (configDir?: string) => {
    const home = homeOf();
    return expandHome(
      configDir ?? (envOf().CLAUDE_CONFIG_DIR?.trim() || claudeDirOf(home)),
      home
    );
  };

  const price = listPrices(
    "anthropic",
    machine.catalog ? { catalog: machine.catalog } : undefined
  );

  return defineProvider({
    credential: (options: AnthropicOptions): AnthropicCredential => {
      if ("apiKey" in options && !options.apiKey?.trim()) {
        throw new Error("The Anthropic API key given is empty or unset.");
      }
      return options.apiKey === undefined
        ? { configDir: configDirOf(options.configDir), kind: "login" }
        : { kind: "api-key" };
    },
    detect: async () => ((await looksUsed(configDirOf())) ? {} : undefined),
    history: async (credential, since, callOptions) => {
      callOptions?.signal?.throwIfAborted();
      if (credential.kind === "api-key") {
        return;
      }
      const works = await readClaudeHistory(
        credential.configDir,
        since,
        callOptions?.signal
      );
      callOptions?.signal?.throwIfAborted();
      return consumptionOf(works, since, price, "notional");
    },
    id: "anthropic",
    limits: async (credential, callOptions) => {
      callOptions?.signal?.throwIfAborted();
      if (credential.kind === "api-key") {
        return {
          limits: [],
          unsupported: "An Anthropic API key has no limits to read.",
        };
      }
      const childEnvironment = routedEnv(credential.configDir);
      const executable = await which("claude", childEnvironment);
      callOptions?.signal?.throwIfAborted();
      return readClaudeLimits({
        cwd: homeOf(),
        env: childEnvironment,
        executable,
        initTimeoutMs: machine.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS,
        ...(machine.query ? { query: machine.query } : {}),
        ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
        usageTimeoutMs: machine.usageTimeoutMs ?? DEFAULT_USAGE_TIMEOUT_MS,
      });
    },
  });
};

export type AnthropicProvider = ReturnType<typeof createAnthropic>;

export const anthropic: AnthropicProvider = createAnthropic();
