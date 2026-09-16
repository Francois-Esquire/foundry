/**
 * The bundled models.dev snapshot, and the enrichment bound to it.
 *
 * Split from `./models-dev` so that adapter stays a pure leaf: its tests run
 * against small inline fixtures instead of loading 120KB, and the snapshot is
 * the only thing a caller has to stub.
 *
 * Bundled rather than fetched because the app must not reach the network for
 * model metadata — Airplane Mode is a shipped feature, and a catalog that
 * depends on connectivity is one that fails exactly when the user is offline.
 * Refresh with `bun run --cwd=packages/models sync:models-dev`.
 */

import type { ProviderModelDefinition } from "../types";
import snapshot from "./data/models-dev.json";
import type { ModelsDevCatalog, ModelsDevIdOptions } from "./models-dev";
import { enrichFromModelsDev } from "./models-dev";

/** Model facts keyed `author/model`, as captured from models.dev. */
export const MODELS_DEV: ModelsDevCatalog = (
  snapshot as { models: ModelsDevCatalog }
).models;

/** {@link enrichFromModelsDev} against the bundled snapshot. */
export function enrichFromSnapshot(
  defs: ProviderModelDefinition[],
  options?: ModelsDevIdOptions
): ProviderModelDefinition[] {
  return enrichFromModelsDev(defs, MODELS_DEV, options);
}
