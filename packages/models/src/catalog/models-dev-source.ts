/**
 * models.dev, read at run time. Nothing is bundled: a host holds the load
 * while it runs, and once the catalog has loaded it is kept for the life of
 * the process and never fetched again. Nothing waits for it: until it is
 * there, and when it could not be read, a price that depends on it is
 * simply absent.
 *
 * A fetch that fails is tried again while any hold remains: after 30 s, then
 * twice as long each time, up to 10 minutes. A new hold tries at once.
 * Holds come from a host starting and from Airplane Mode turning off, and
 * each try is bounded by a timeout, so a dead network is never hammered.
 * When the last hold is released, a running fetch is aborted and a waiting
 * retry is cancelled, so a host that has finished is never held open. An
 * aborted fetch keeps nothing, even if it completes later.
 *
 * `FOUNDRY_MODELS_DEV_URL` names another source, such as a mirror. Set it to
 * an empty value to load nothing.
 */

import type { ModelsDevCatalog } from "./models-dev";
import { modelsDevCatalog } from "./models-dev";

const SOURCE = "https://models.dev/catalog.json";
const TIMEOUT_MS = 15_000;
const RETRY_FIRST_MS = 30_000;
const RETRY_MAX_MS = 600_000;

/** A host's claim on the models.dev load. */
export interface ModelsDevHold {
  /**
   * Settles when the fetch this hold started or joined does: the catalog,
   * or `undefined`. Retries do not settle it. Never rejects.
   */
  readonly loaded: Promise<ModelsDevCatalog | undefined>;
  /** Give up the claim; idempotent. */
  release(): void;
}

interface Attempt {
  readonly controller: AbortController;
  readonly loaded: Promise<ModelsDevCatalog | undefined>;
}

/** Set once a fetch returned a catalog: it is never fetched again. */
let loaded: ModelsDevCatalog | undefined;
/** Holds not yet released. */
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
  // An aborted fetch was given up, and a later one may have loaded since.
  if (signal.aborted) {
    return;
  }
  // Only a catalog is kept.
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
        // A retry alone never keeps the process open.
        retry.unref?.();
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      }
      return catalog;
    }),
  };
  return current;
}

/**
 * Hold the models.dev load: starts it unless the catalog has loaded or a
 * fetch is running, and joins a running one. Release the hold when the host
 * stops.
 */
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

/** The catalog once a load has finished, else `undefined`. Never fetches. */
export function loadedModelsDev(): ModelsDevCatalog | undefined {
  return loaded;
}
