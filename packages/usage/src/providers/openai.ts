import { spawn as nodeSpawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  recordChild,
  spawnRecordEnvironment,
} from "@foundry/lib/node/spawn-record";

import {
  consumptionOf,
  type ListPricesOptions,
  listPrices,
} from "../consumption";
import { defineProvider } from "../provider";
import { childEnv, type Env, exists, expandHome } from "./machine";
import { readCodexHistory } from "./openai/history";
import { readCodexLimits, type SpawnCodex } from "./openai/limits";

export type { OpenAIDetails } from "./openai/limits";

export type OpenAIOptions =
  | { readonly apiKey?: undefined; readonly home?: string }
  | { readonly apiKey: string; readonly home?: undefined };

type OpenAICredential =
  | { readonly home: string; readonly kind: "login" }
  | { readonly kind: "api-key" };

export interface OpenAIMachine {
  readonly catalog?: ListPricesOptions["catalog"];
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
    env: { ...spawnRecordEnvironment(), ...options.env },
    stdio: "pipe",
  });
  recordChild(child);
  return child;
};

export const createOpenAI = (machine: OpenAIMachine = {}) => {
  const envOf = () => machine.env ?? process.env;
  const homeOf = () => machine.home ?? homedir();
  const codexHomeOf = (codexHome?: string) => {
    const home = homeOf();
    return expandHome(
      codexHome ?? (envOf().CODEX_HOME?.trim() || join(home, ".codex")),
      home
    );
  };

  const price = listPrices(
    "openai",
    machine.catalog ? { catalog: machine.catalog } : undefined
  );

  return defineProvider({
    credential: (options: OpenAIOptions): OpenAICredential => {
      if ("apiKey" in options && !options.apiKey?.trim()) {
        throw new Error("The OpenAI API key given is empty or unset.");
      }
      return options.apiKey === undefined
        ? { home: codexHomeOf(options.home), kind: "login" }
        : { kind: "api-key" };
    },
    detect: async () => {
      const codexHome = codexHomeOf();
      return (await exists(join(codexHome, "auth.json"))) ||
        (await exists(join(codexHome, "sessions")))
        ? {}
        : undefined;
    },
    history: async (credential, since, callOptions) => {
      callOptions?.signal?.throwIfAborted();
      if (credential.kind === "api-key") {
        return;
      }
      const works = await readCodexHistory(
        credential.home,
        since,
        callOptions?.signal
      );
      callOptions?.signal?.throwIfAborted();
      return consumptionOf(works, since, price, "notional");
    },
    id: "openai",
    limits: async (credential, callOptions) => {
      callOptions?.signal?.throwIfAborted();
      if (credential.kind === "api-key") {
        return {
          limits: [],
          unsupported: "An OpenAI API key has no limits to read.",
        };
      }
      return readCodexLimits({
        cwd: homeOf(),
        env: childEnv(envOf(), FOREIGN_AUTH, { CODEX_HOME: credential.home }),
        ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
        spawn: machine.spawn ?? spawnCodex,
        timeoutMs: machine.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    },
  });
};

export type OpenAIProvider = ReturnType<typeof createOpenAI>;

export const openai: OpenAIProvider = createOpenAI();
