import { spawn as nodeSpawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Credential, Provider } from "../../usage";
import { childEnv, type Env, exists, expandHome, fingerprint } from "../local";
import { consumptionOf, listPrices, type Price } from "../work";
import { readCodexHistory } from "./history";
import { readCodexLimits, type SpawnCodex } from "./limits";

/** A Codex login, reached through its home directory. */
export interface OpenAILogin extends Credential {
  /** Absolute; Codex runs with it as `CODEX_HOME`. */
  readonly home: string;
  readonly kind: "login";
  readonly provider: "openai";
}

/** An OpenAI API key. Its `id` is a fingerprint of the key. */
export interface OpenAIApiKey extends Credential {
  readonly key: string;
  readonly kind: "api-key";
  readonly provider: "openai";
}

export type OpenAICredential = OpenAILogin | OpenAIApiKey;

export interface OpenAIProvider extends Provider {
  /** An OpenAI API key, such as `process.env.OPENAI_API_KEY`. */
  apiKey(key: string): OpenAIApiKey;
  /** The default login when it looks signed in, and the environment's API key. */
  detect(): Promise<readonly OpenAICredential[]>;
  readonly id: "openai";
  /**
   * A Codex login. `home` is the directory `CODEX_HOME` would name, `~`
   * allowed; by default the one Codex uses here.
   */
  login(options?: { readonly home?: string }): OpenAILogin;
  price: Price;
}

/** What a test replaces: this machine, and how `codex` is started. */
export interface OpenAIOptions {
  readonly env?: Env;
  readonly home?: string;
  readonly spawn?: SpawnCodex;
  readonly timeoutMs?: number;
}

const PROVIDER = "openai";
const DEFAULT_TIMEOUT_MS = 5000;
/** Removed from a login's environment so it reads its own login, not a key. */
const FOREIGN_AUTH = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_HOME"];

const spawnCodex: SpawnCodex = (command, args, options) =>
  nodeSpawn(command, args, { ...options, stdio: "pipe" });

const credentialOf = (credential: Credential): OpenAICredential => {
  const { kind } = credential as Partial<OpenAICredential>;
  if (
    credential.provider !== PROVIDER ||
    !(kind === "login" || kind === "api-key")
  ) {
    throw new Error(`"${credential.id}" is not an OpenAI credential.`);
  }
  return credential as OpenAICredential;
};

/** An OpenAI provider over this machine, or over what `options` replaces. */
export const createOpenAI = (options: OpenAIOptions = {}): OpenAIProvider => {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();

  const login = ({
    home: codexHome,
  }: {
    readonly home?: string;
  } = {}): OpenAILogin => {
    const dir = expandHome(
      codexHome ?? (env.CODEX_HOME?.trim() || join(home, ".codex")),
      home
    );
    return { home: dir, id: dir, kind: "login", provider: PROVIDER };
  };

  const apiKey = (key: string): OpenAIApiKey => ({
    id: fingerprint(key),
    key,
    kind: "api-key",
    provider: PROVIDER,
  });

  return {
    apiKey,
    detect: async () => {
      const found: OpenAICredential[] = [];
      const defaultLogin = login();
      // Presence only: Codex writes `auth.json` when it signs in.
      if (await exists(join(defaultLogin.home, "auth.json"))) {
        found.push(defaultLogin);
      }
      if (env.OPENAI_API_KEY?.trim()) {
        found.push(apiKey(env.OPENAI_API_KEY.trim()));
      }
      return found;
    },
    history: async (credential, since) => {
      const found = credentialOf(credential);
      if (found.kind === "api-key") {
        return;
      }
      const works = await readCodexHistory(found.home, since);
      return consumptionOf(works, since, listPrices(PROVIDER), "notional");
    },
    id: PROVIDER,
    limits: (credential) => {
      const found = credentialOf(credential);
      if (found.kind === "api-key") {
        return Promise.resolve({
          limits: [],
          unsupported: "An OpenAI API key has no limits to read.",
        });
      }
      return readCodexLimits({
        // Not a project directory, so no project config is read.
        cwd: home,
        env: childEnv(env, FOREIGN_AUTH, { CODEX_HOME: found.home }),
        spawn: options.spawn ?? spawnCodex,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    },
    login,
    price: (model, quantities) => listPrices(PROVIDER)(model, quantities),
  };
};
