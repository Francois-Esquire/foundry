import type { ModelsDevCatalog } from "./models-dev";
import { modelsDevCatalog } from "./models-dev";

const SOURCE = "https://models.dev/catalog.json";
const TIMEOUT_MS = 15_000;
const RETRY_FIRST_MS = 30_000;
const RETRY_MAX_MS = 600_000;

export interface ModelsDevHold {
  readonly loaded: Promise<ModelsDevCatalog | undefined>;
  release(): void;
}

interface Attempt {
  readonly controller: AbortController;
  readonly loaded: Promise<ModelsDevCatalog | undefined>;
}

let loaded: ModelsDevCatalog | undefined;
let holds = 0;
let attempt: Attempt | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
let retryMs = RETRY_FIRST_MS;

async function fetchCatalog(
  url: string,
  signal: AbortSignal
): Promise<ModelsDevCatalog | undefined> {
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
  }).catch(() => undefined);
  const catalog = response?.ok
    ? modelsDevCatalog(await response.json().catch(() => undefined))
    : undefined;
  if (signal.aborted) {
    return;
  }
  if (catalog) {
    loaded = catalog;
  }
  return catalog;
}

function cancelRetry(): void {
  clearTimeout(retry);
  retry = undefined;
}

function start(url: string): Attempt {
  cancelRetry();
  const controller = new AbortController();
  const current: Attempt = {
    controller,
    loaded: fetchCatalog(url, controller.signal).then((catalog) => {
      if (attempt !== current) {
        return catalog;
      }
      attempt = undefined;
      if (!catalog && holds > 0) {
        retry = setTimeout(() => {
          retry = undefined;
          attempt = start(url);
        }, retryMs);
        retry.unref?.();
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      }
      return catalog;
    }),
  };
  return current;
}

export function holdModelsDev(): ModelsDevHold {
  const url = process.env.FOUNDRY_MODELS_DEV_URL ?? SOURCE;
  if (loaded || !url) {
    return { loaded: Promise.resolve(loaded), release: () => undefined };
  }
  attempt ??= start(url);
  holds += 1;
  let held = true;
  return {
    loaded: attempt.loaded,
    release: () => {
      if (!held) {
        return;
      }
      held = false;
      holds -= 1;
      if (holds === 0) {
        cancelRetry();
        retryMs = RETRY_FIRST_MS;
        attempt?.controller.abort();
        attempt = undefined;
      }
    },
  };
}

export function loadedModelsDev(): ModelsDevCatalog | undefined {
  return loaded;
}
