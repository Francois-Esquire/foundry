/**
 * models.dev, read at run time. Nothing is bundled: the catalog is fetched
 * once per process, the first time `loadModelsDev` is called, and kept for
 * the life of the process. A failed or slow fetch leaves no catalog and
 * throws nothing, so a price that depends on it is simply absent.
 *
 * `FOUNDRY_MODELS_DEV_URL` names another source, such as a mirror. Set it to
 * an empty value to load nothing.
 */

import type { ModelsDevCatalog } from "./models-dev";
import { modelsDevCatalog } from "./models-dev";

const SOURCE = "https://models.dev/catalog.json";
const TIMEOUT_MS = 15_000;

let loading: Promise<ModelsDevCatalog | undefined> | undefined;
let loaded: ModelsDevCatalog | undefined;

/** Unreachable, slow or malformed: no catalog, and no price that needs it. */
async function fetchCatalog(
  url: string
): Promise<ModelsDevCatalog | undefined> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => undefined);
  if (!response?.ok) {
    return;
  }
  loaded = modelsDevCatalog(await response.json().catch(() => undefined));
  return loaded;
}

/**
 * Start loading models.dev, or join the load already started. Resolves with
 * the catalog, or `undefined` when it could not be read. Never rejects.
 */
export function loadModelsDev(): Promise<ModelsDevCatalog | undefined> {
  const url = process.env.FOUNDRY_MODELS_DEV_URL ?? SOURCE;
  loading ??= url ? fetchCatalog(url) : Promise.resolve(undefined);
  return loading;
}

/** The catalog once a load has finished, else `undefined`. Never fetches. */
export function loadedModelsDev(): ModelsDevCatalog | undefined {
  return loaded;
}
