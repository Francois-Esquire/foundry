/**
 * Bundled model metadata supports offline use.
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
