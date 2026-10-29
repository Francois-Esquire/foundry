import { spawn as nodeSpawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import { consumptionOf, listPrices } from "../../consumption";
import { type DefinedProvider, defineProvider } from "../../provider";
import { childEnv, type Env, exists, expandHome } from "../local";
import { readCodexHistory } from "./history";
import { readCodexLimits, type SpawnCodex } from "./limits";

/**
 * A Codex login by its home, the directory `CODEX_HOME` would name (`~`
 * allowed; by default the one Codex uses here), or an OpenAI API key, such
 * as `process.env.OPENAI_API_KEY`.
 */
export type OpenAIOptions =
  | { readonly apiKey?: undefined; readonly home?: string }
  | { readonly apiKey: string; readonly home?: undefined };

export type OpenAICredential =
  /** `home` is absolute; Codex runs with it as `CODEX_HOME`. */
  | { readonly home: string; readonly kind: "login" }
  | { readonly key: string; readonly kind: "api-key" };

export type OpenAIProvider = DefinedProvider<
  "openai",
  OpenAIOptions,
  OpenAICredential
>;

/** What a test replaces: this machine, and how `codex` is started. */
export interface OpenAIMachine {
  readonly env?: Env;
  readonly home?: string;
  readonly spawn?: SpawnCodex;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
/** Removed from a login's environment so it reads its own login, not a key. */
const FOREIGN_AUTH = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_HOME"];

const spawnCodex: SpawnCodex = (command, args, options) =>
  nodeSpawn(command, args, { ...options, stdio: "pipe" });

/** An OpenAI provider over this machine, or over what `machine` replaces. */
export const createOpenAI = (machine: OpenAIMachine = {}): OpenAIProvider => {
  const env = machine.env ?? process.env;
  const home = machine.home ?? homedir();
  const codexHomeOf = (codexHome?: string) =>
    expandHome(
      codexHome ?? (env.CODEX_HOME?.trim() || join(home, ".codex")),
      home
    );

  return defineProvider({
    credential: (options: OpenAIOptions): OpenAICredential => {
      // An unset key never falls back to the default login under another name.
      if ("apiKey" in options && !options.apiKey?.trim()) {
        throw new Error("The OpenAI API key given is empty or unset.");
      }
      return options.apiKey === undefined
        ? { home: codexHomeOf(options.home), kind: "login" }
        : { key: options.apiKey, kind: "api-key" };
    },
    // Presence only: Codex writes `auth.json` when it signs in.
    detect: async () =>
      (await exists(join(codexHomeOf(), "auth.json"))) ? {} : undefined,
    history: async (credential, since) => {
      if (credential.kind === "api-key") {
        return;
      }
      const works = await readCodexHistory(credential.home, since);
      return consumptionOf(works, since, listPrices("openai"), "notional");
    },
    id: "openai",
    limits: async (credential) => {
      if (credential.kind === "api-key") {
        return {
          limits: [],
          unsupported: "An OpenAI API key has no limits to read.",
        };
      }
      return readCodexLimits({
        // Not a project directory, so no project config is read.
        cwd: home,
        env: childEnv(env, FOREIGN_AUTH, { CODEX_HOME: credential.home }),
        spawn: machine.spawn ?? spawnCodex,
        timeoutMs: machine.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    },
  });
};
