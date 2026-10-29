import { homedir } from "node:os";
import { join } from "node:path";

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";

import type { Credential, Provider } from "../../usage";
import {
  childEnv,
  type Env,
  exists,
  expandHome,
  fingerprint,
  which,
} from "../local";
import { consumptionOf, listPrices, type Price } from "../work";
import { readClaudeHistory } from "./history";
import { type ClaudeQuery, readClaudeLimits } from "./limits";

/** A Claude Code login, reached through its config directory. */
export interface AnthropicLogin extends Credential {
  /** Absolute; Claude Code runs with it as `CLAUDE_CONFIG_DIR`. */
  readonly configDir: string;
  readonly kind: "login";
  readonly provider: "anthropic";
}

/** An Anthropic API key. Its `id` is a fingerprint of the key. */
export interface AnthropicApiKey extends Credential {
  readonly key: string;
  readonly kind: "api-key";
  readonly provider: "anthropic";
}

export type AnthropicCredential = AnthropicLogin | AnthropicApiKey;

export interface AnthropicProvider extends Provider {
  /** An Anthropic API key, such as `process.env.ANTHROPIC_API_KEY`. */
  apiKey(key: string): AnthropicApiKey;
  /** The default login when it looks signed in, and the environment's API key. */
  detect(): Promise<readonly AnthropicCredential[]>;
  readonly id: "anthropic";
  /**
   * A Claude Code login. `configDir` is the directory `CLAUDE_CONFIG_DIR`
   * would name, `~` allowed; by default the one Claude Code uses here.
   */
  login(options?: { readonly configDir?: string }): AnthropicLogin;
  price: Price;
}

/** What a test replaces: this machine, and the Agent SDK. */
export interface AnthropicOptions {
  readonly env?: Env;
  readonly home?: string;
  readonly initTimeoutMs?: number;
  readonly query?: ClaudeQuery;
  readonly usageTimeoutMs?: number;
}

const PROVIDER = "anthropic";
const DEFAULT_INIT_TIMEOUT_MS = 10_000;
const DEFAULT_USAGE_TIMEOUT_MS = 5000;
/** Removed from a login's environment so it reads its own login, not a key or token. */
const FOREIGN_AUTH = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
];

const credentialOf = (credential: Credential): AnthropicCredential => {
  const { kind } = credential as Partial<AnthropicCredential>;
  if (
    credential.provider !== PROVIDER ||
    !(kind === "login" || kind === "api-key")
  ) {
    throw new Error(`"${credential.id}" is not an Anthropic credential.`);
  }
  return credential as AnthropicCredential;
};

/** An Anthropic provider over this machine, or over what `options` replaces. */
export const createAnthropic = (
  options: AnthropicOptions = {}
): AnthropicProvider => {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const homeDir = join(home, ".claude");

  const login = ({
    configDir,
  }: {
    readonly configDir?: string;
  } = {}): AnthropicLogin => {
    const dir = expandHome(
      configDir ?? (env.CLAUDE_CONFIG_DIR?.trim() || homeDir),
      home
    );
    return { configDir: dir, id: dir, kind: "login", provider: PROVIDER };
  };

  const apiKey = (key: string): AnthropicApiKey => ({
    id: fingerprint(key),
    key,
    kind: "api-key",
    provider: PROVIDER,
  });

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

  return {
    apiKey,
    detect: async () => {
      const found: AnthropicCredential[] = [];
      const defaultLogin = login();
      if (await looksSignedIn(defaultLogin.configDir)) {
        found.push(defaultLogin);
      }
      if (env.ANTHROPIC_API_KEY?.trim()) {
        found.push(apiKey(env.ANTHROPIC_API_KEY.trim()));
      }
      return found;
    },
    history: async (credential, since) => {
      const found = credentialOf(credential);
      if (found.kind === "api-key") {
        return;
      }
      const works = await readClaudeHistory(found.configDir, since);
      return consumptionOf(works, since, listPrices(PROVIDER), "notional");
    },
    id: PROVIDER,
    limits: async (credential) => {
      const found = credentialOf(credential);
      if (found.kind === "api-key") {
        return {
          limits: [],
          unsupported: "An Anthropic API key has no limits to read.",
        };
      }
      const childEnvironment = routedEnv(found.configDir);
      return readClaudeLimits({
        // Not a project directory, so no project config is read.
        cwd: home,
        env: childEnvironment,
        executable: await which("claude", childEnvironment),
        initTimeoutMs: options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS,
        query: options.query ?? sdkQuery,
        usageTimeoutMs: options.usageTimeoutMs ?? DEFAULT_USAGE_TIMEOUT_MS,
      });
    },
    login,
    price: (model, quantities) => listPrices(PROVIDER)(model, quantities),
  };
};
