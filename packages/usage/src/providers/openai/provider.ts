import { spawn as nodeSpawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { recordChild, spawnRecordEnvironment } from "@foundry/lib/spawn-record";

import { consumptionOf, listPrices } from "../../consumption";
import { defineProvider } from "../../provider";
import { childEnv, type Env, exists, expandHome } from "../local";
import { readCodexHistory } from "./history";
import { readCodexLimits, type SpawnCodex } from "./limits";

export type OpenAIOptions =
  | { readonly apiKey?: undefined; readonly home?: string }
  | { readonly apiKey: string; readonly home?: undefined };

export type OpenAICredential =
  | { readonly home: string; readonly kind: "login" }
  | { readonly key: string; readonly kind: "api-key" };

export interface OpenAIMachine {
  readonly env?: Env;
  readonly home?: string;
  readonly spawn?: SpawnCodex;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const FOREIGN_AUTH = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_HOME"];

const spawnCodex: SpawnCodex = (command, args, options) => {
  const child = nodeSpawn(command, args, {
    ...options,
    env: { ...options.env, ...spawnRecordEnvironment() },
    stdio: "pipe",
  });
  recordChild(child);
  return child;
};

export const createOpenAI = (machine: OpenAIMachine = {}) => {
  const env = machine.env ?? process.env;
  const home = machine.home ?? homedir();
  const codexHomeOf = (codexHome?: string) =>
    expandHome(
      codexHome ?? (env.CODEX_HOME?.trim() || join(home, ".codex")),
      home
    );

  return defineProvider({
    credential: (options: OpenAIOptions): OpenAICredential => {
      if ("apiKey" in options && !options.apiKey?.trim()) {
        throw new Error("The OpenAI API key given is empty or unset.");
      }
      return options.apiKey === undefined
        ? { home: codexHomeOf(options.home), kind: "login" }
        : { key: options.apiKey, kind: "api-key" };
    },
    detect: async () => {
      const codexHome = codexHomeOf();
      return (await exists(join(codexHome, "auth.json"))) ||
        (await exists(join(codexHome, "sessions")))
        ? {}
        : undefined;
    },
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
        cwd: home,
        env: childEnv(env, FOREIGN_AUTH, { CODEX_HOME: credential.home }),
        spawn: machine.spawn ?? spawnCodex,
        timeoutMs: machine.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    },
  });
};

export type OpenAIProvider = ReturnType<typeof createOpenAI>;
