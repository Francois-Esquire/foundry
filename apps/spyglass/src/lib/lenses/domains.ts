import type { DomainDeclaration } from "../domain-declaration";
import { covers } from "../facet-cover";
import { byId, sorted } from "../workspace-projection";
import type {
  DomainLabel,
  DomainMatch,
  DomainPlacement,
} from "./domains-types";
import { DOMAINS_SCHEMA_VERSION } from "./domains-types";
import type { Lens } from "./lens-types";
import type { Placement } from "./placement-types";
import type { Places } from "./places";
import {
  kindOf,
  packageRoots,
  packagesNamedBySymbols,
  placesOf,
  readSymbols,
} from "./places";

export interface DomainsSourcePlacement
  extends Pick<
    Placement,
    "label" | "level" | "package" | "place" | "unindexed"
  > {
  away: string[];
}

export interface DomainsSource {
  files: string[];
  packages: string[];
  placements: DomainsSourcePlacement[];
  symbols: string[];
}

const NOTHING_DECLARED: DomainsSource = {
  files: [],
  packages: [],
  placements: [],
  symbols: [],
};

interface FlatDomain {
  declaration: DomainDeclaration;
  facets: readonly string[];
  parents: string[];
}

function flatten(
  declarations: readonly DomainDeclaration[],
  parents: string[] = []
): FlatDomain[] {
  return declarations.flatMap((declaration) => [
    { declaration, facets: declaration.facets ?? [], parents },
    ...flatten(declaration.domains ?? [], [...parents, declaration.name]),
  ]);
}

function matchOf(domain: FlatDomain, places: Places): DomainMatch {
  const { name, reason, weight } = domain.declaration;
  const matched: DomainMatch["places"] = [];
  const unmatched: string[] = [];
  for (const facet of domain.facets) {
    const kind = kindOf(facet, places);
    if (kind === undefined) {
      unmatched.push(facet);
    } else {
      matched.push({ kind, place: facet });
    }
  }
  return {
    name,
    parents: domain.parents,
    places: matched.sort((a, b) => byId(a.place, b.place)),
    ...(reason !== undefined && { reason }),
    unmatched: unmatched.sort(byId),
    ...(weight !== undefined && { weight }),
  };
}

function membership(
  domains: readonly FlatDomain[]
): (place: string) => string[] {
  const known = new Map<string, string[]>();
  return (place) => {
    let names = known.get(place);
    if (names === undefined) {
      names = sorted(
        domains
          .filter((domain) =>
            domain.facets.some((facet) => covers(facet, place))
          )
          .flatMap((domain) => [...domain.parents, domain.declaration.name])
      );
      known.set(place, names);
    }
    return names;
  };
}

function labelOf(
  placementLabel: DomainsSourcePlacement["label"],
  away: DomainPlacement["away"]
): DomainLabel {
  if (placementLabel === "fits") {
    return "fits";
  }
  const allShare =
    away.total > 0 && away.shared === away.total && away.unindexed === 0;
  return allShare ? "shares-domain" : placementLabel;
}

function placementOf(
  placement: DomainsSourcePlacement,
  domainsOf: (place: string) => string[]
): DomainPlacement | undefined {
  const domains = domainsOf(placement.place);
  if (domains.length === 0) {
    return;
  }
  const own = new Set(domains);
  const shared = new Set<string>();
  let sharing = 0;
  for (const module of placement.away) {
    const common = domainsOf(module).filter((name) => own.has(name));
    if (common.length > 0) {
      sharing += 1;
    }
    for (const name of common) {
      shared.add(name);
    }
  }
  const away = {
    shared: sharing,
    total: placement.away.length,
    unindexed: placement.unindexed,
  };
  return {
    away,
    domainLabel: labelOf(placement.label, away),
    domains: [...domains],
    level: placement.level,
    package: placement.package,
    place: placement.place,
    placementLabel: placement.label,
    sharedDomains: sorted(shared),
  };
}

export const domainsLens: Lens<"domains", DomainsSource, "domains"> = {
  consumes: ["placement"],
  derive: (source, { domains: declared }) => {
    const domains = flatten(declared);
    if (domains.length === 0) {
      return { domains: [], placements: [] };
    }
    const places = placesOf(source);
    const domainsOf = membership(domains);
    return {
      domains: domains
        .map((domain) => matchOf(domain, places))
        .sort((a, b) => byId(a.name, b.name)),
      placements: source.placements
        .flatMap((placement) => placementOf(placement, domainsOf) ?? [])
        .sort(
          (a, b) =>
            byId(a.place, b.place) ||
            byId(a.level, b.level) ||
            byId(a.package, b.package)
        ),
    };
  },
  id: "domains",
  read: async (reader, { domains: declared }) => {
    if (declared.length === 0) {
      return NOTHING_DECLARED;
    }
    const listed = reader.packages();
    const [index, placement] = await Promise.all([
      reader.moduleIndex(),
      reader.lens("placement"),
    ]);
    const facets = flatten(declared).flatMap((domain) => domain.facets);
    return {
      files: index.modules.map((module) => module.id),
      packages: packageRoots(listed),
      placements: placement.places.map(
        ({ away, label, level, package: pkg, place, unindexed }) => ({
          away: away.flatMap(({ modules }) => modules),
          label,
          level,
          package: pkg,
          place,
          unindexed,
        })
      ),
      symbols: await readSymbols(
        reader,
        packagesNamedBySymbols(listed, facets)
      ),
    };
  },
  schemaVersion: DOMAINS_SCHEMA_VERSION,
  settings: ["domains"],
};
