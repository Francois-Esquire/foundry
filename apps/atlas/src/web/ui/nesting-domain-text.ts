import { byCodeUnit } from "@foundry/lib/ordering";
import { covers } from "../../lib/facet-cover";
import type { AtlasData, Territory } from "../types";

/** What the nesting and domain readings take from the atlas. */
type Readings = Pick<AtlasData, "domains" | "nesting">;

/** The seams Place names for an island, the strongest first. */
const seamsNamed = 2;

const byName = byCodeUnit((name: string) => name);

/** A file's path region, from the `nesting` lens: "path region lib"; nothing where the internals list none. */
export function pathRegionText(
  atlas: Readings,
  directory: string
): string | undefined {
  const region = atlas.nesting.folders.find(
    (folder) => folder.id === directory
  )?.pathRegion;
  return region === undefined ? undefined : `path region ${region}`;
}

/**
 * An island's path regions and its strongest seams, the primary edges from
 * one region into another: "4 path regions · seams web → lib 39 module
 * edges, views → components 34"; nothing where the internals list none.
 */
export function islandNestingText(
  atlas: Readings,
  territory: Territory
): string | undefined {
  const regions = atlas.nesting.pathRegions.filter(
    (region) => region.package === territory.id
  ).length;
  if (!regions) {
    return;
  }
  const seams = atlas.nesting.seams
    .filter((seam) => seam.package === territory.id)
    .toSorted(
      (a, b) =>
        b.moduleEdges - a.moduleEdges ||
        byName(a.from, b.from) ||
        byName(a.to, b.to)
    )
    .slice(0, seamsNamed)
    .map((seam, i) =>
      i
        ? `${seam.from} → ${seam.to} ${seam.moduleEdges}`
        : `${seam.from} → ${seam.to} ${seam.moduleEdges} module edges`
    );
  const named = seams.length ? ` · seams ${seams.join(", ")}` : "";
  return `${regions} path ${regions === 1 ? "region" : "regions"}${named}`;
}

/**
 * The declared domains a place lies in: those with a facet covering it, as
 * the configuration matches facets (a file facet covers the file's
 * symbols), and every domain they are nested in.
 */
function domainsOf(atlas: Readings, place: string): string[] {
  const found = new Set<string>();
  for (const domain of atlas.domains.declared) {
    if (domain.places.some((facet) => covers(facet.place, place))) {
      found.add(domain.name);
      for (const parent of domain.parents) {
        found.add(parent);
      }
    }
  }
  return [...found].sort(byName);
}

/** A place's domains, as Place reads them: "domains: shapes, ui"; nothing outside every domain. */
export function domainsText(
  atlas: Readings,
  place: string
): string | undefined {
  const domains = domainsOf(atlas, place);
  return domains.length ? `domains: ${domains.join(", ")}` : undefined;
}

/**
 * A placed place's domain label, beside its placement label, from the
 * `domains` lens: "domain departure: 2 of 5 consumer modules in other
 * packages share its domains", with any consumers outside the module index
 * said apart, or "shares its domains with every consumer"; nothing for a
 * place in no domain.
 */
export function domainLabelText(
  atlas: Readings,
  key: string
): string | undefined {
  const placed = atlas.domains.placements[key];
  if (!placed) {
    return;
  }
  if (placed.domainLabel === "shares-domain") {
    return `shares ${placed.sharedDomains.join(", ")} with every consumer`;
  }
  if (placed.domainLabel === "departs") {
    const { shared, total, unindexed } = placed.away;
    const unknown = unindexed
      ? `; ${unindexed} ${unindexed === 1 ? "consumer" : "consumers"} outside the module index can't be shown to share them`
      : "";
    return `domain departure: ${shared} of ${total} consumer modules in other packages share its domains${unknown}`;
  }
}
