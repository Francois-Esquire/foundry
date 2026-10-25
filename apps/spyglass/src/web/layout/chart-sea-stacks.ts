import {
  defaultSeaStackSettings,
  type OwnDependency,
  type SeaStack,
  type SeaStackSettings,
  seaStacks,
} from "../../lib/visualization/sea-stacks";
import type { SpyglassData } from "../data/types";

/**
 * The chart's sea stacks, from its settled islands and each package's own
 * third-party dependencies, as `ownDependencies` derives them from a
 * workspace's dependency inventory, by island id as the map holds it: one
 * stack off a package's coast for each dependency only it relies on. With
 * no dependencies given there are no stacks; the chart invents none.
 */
export function chartSeaStacks(
  data: Pick<SpyglassData, "territories">,
  dependencies: readonly OwnDependency[],
  settings: SeaStackSettings = defaultSeaStackSettings
): SeaStack[] {
  return seaStacks(
    {
      islands: data.territories.map((territory) => ({
        coast: territory.coast,
        id: territory.id,
        radius: territory.radius,
        x: territory.x,
        y: territory.y,
      })),
      sources: dependencies.map((dependency) => ({
        islandId: dependency.territoryId,
        label: dependency.name,
        members: [dependency.territoryId, `dependency:${dependency.name}`],
        reliance: dependency.reliance,
      })),
    },
    settings
  );
}
