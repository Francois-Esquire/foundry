/**
 * models.dev, read at run time. Nothing is bundled: a host holds the load
 * while it runs, and once the catalog has loaded it is kept for the life of
 * the process and never fetched again. Nothing waits for it: until it is
 * there, and when it could not be read, a price that depends on it is
 * simply absent.
 *
 * A fetch that fails is not retried on its own; the next hold tries again,
 * so a host that started offline is priced once a later hold finds the
 * network. Holds come from a host starting and from Airplane Mode turning
 * off, and each try is bounded by a timeout, so a dead network is never
 * hammered. When the last hold is released before the fetch finishes, the
 * fetch is aborted, so a host that has finished is never held open by it.
 *
 * `FOUNDRY_MODELS_DEV_URL` names another source, such as a mirror. Set it to
 * an empty value to load nothing.
 */

import type { ModelsDevCatalog } from "./models-dev";
import { modelsDevCatalog } from "./models-dev";

const SOURCE = "https://models.dev/catalog.json";
const TIMEOUT_MS = 15_000;

/** A host's claim on the models.dev load. */
export interface ModelsDevHold {
  /** Settles when the load does: the catalog, or `undefined`. Never rejects. */
  readonly loaded: Promise<ModelsDevCatalog | undefined>;
  /** Give up the claim; idempotent. */
  release(): void;
}

interface Pending {
  readonly controller: AbortController;
  holds: number;
  readonly loaded: Promise<ModelsDevCatalog | undefined>;
}

/** Set once a fetch returned a catalog: it is never fetched again. */
let loaded: ModelsDevCatalog | undefined;
let pending: Pending | undefined;

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
  // Only a catalog is kept. A failed or aborted fetch leaves nothing, and
  // a later hold tries again.
  if (catalog) {
    loaded = catalog;
  }
  return catalog;
}

function start(url: string): Pending {
  const controller = new AbortController();
  const load: Pending = {
    controller,
    holds: 0,
    loaded: fetchCatalog(url, controller.signal).finally(() => {
      if (pending === load) {
        pending = undefined;
      }
    }),
  };
  return load;
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
  pending ??= start(url);
  const load = pending;
  load.holds += 1;
  let held = true;
  return {
    loaded: load.loaded,
    release: () => {
      if (!held) {
        return;
      }
      held = false;
      load.holds -= 1;
      if (load.holds === 0 && pending === load) {
        pending = undefined;
        load.controller.abort();
      }
    },
  };
}

/** The catalog once a load has finished, else `undefined`. Never fetches. */
export function loadedModelsDev(): ModelsDevCatalog | undefined {
  return loaded;
}
