/**
 * models.dev, read at run time. Nothing is bundled: a host holds the load
 * while it runs, the catalog is fetched once, and it is kept for the life
 * of the process. Nothing waits for it: until it is there, and when it could
 * not be read, a price that depends on it is simply absent.
 *
 * When the last hold is released before the fetch finishes, the fetch is
 * aborted, so a host that has finished is never held open by it; a later
 * hold starts it again. A catalog already loaded stays usable.
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

let loaded: ModelsDevCatalog | undefined;
/** Set once a fetch completed, with or without a catalog: it is not tried again. */
let settled = false;
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
  // An aborted fetch was given up, not tried: a later hold tries again.
  if (!signal.aborted) {
    loaded = catalog;
    settled = true;
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
 * Hold the models.dev load: starts it unless it already ran or is running,
 * and joins it otherwise. Release the hold when the host stops.
 */
export function holdModelsDev(): ModelsDevHold {
  const url = process.env.FOUNDRY_MODELS_DEV_URL ?? SOURCE;
  if (settled || !url) {
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
