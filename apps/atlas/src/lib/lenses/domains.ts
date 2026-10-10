import type { DomainDeclaration } from "../domain-declaration";
import { byId, sorted } from "../workspace-projection";
import type {
  DomainLabel,
  DomainMatch,
  DomainPlaceKind,
  DomainPlacement,
} from "./domains-types";
import { DOMAINS_SCHEMA_VERSION } from "./domains-types";
import type { Lens, LensReader } from "./lens-types";
import { folderOf, WORKSPACE_ROOT } from "./paths";
import type { Placement } from "./placement-types";

/** One placed place, by the fields the lens reads; `away` flattens its consumer modules in other packages. */
export interface DomainsSourcePlacement
  extends Pick<
    Placement,
    "label" | "level" | "package" | "place" | "unindexed"
  > {
  away: string[];
}

/** Every dataset field the lens reads. */
export interface DomainsSource {
  /** Every file of the module index, workspace-relative. */
  files: string[];
  /** The root path of every complete package; a package at the workspace root has none a facet can name. */
  packages: string[];
  placements: DomainsSourcePlacement[];
  /** Every symbol id, exported or not, of each complete package whose root holds the file of a symbol facet. */
  symbols: string[];
}

/** What the lens reads when no domain is declared: nothing. */
const NOTHING_DECLARED: DomainsSource = {
  files: [],
  packages: [],
  placements: [],
  symbols: [],
};

/** A declared domain, out of its nesting. */
interface FlatDomain {
  declaration: DomainDeclaration;
  facets: readonly string[];
  parents: string[];
}

/** Every domain, a parent before the domains nested in it. */
function flatten(
  declarations: readonly DomainDeclaration[],
  parents: string[] = []
): FlatDomain[] {
  return declarations.flatMap((declaration) => [
    { declaration, facets: declaration.facets ?? [], parents },
    ...flatten(declaration.domains ?? [], [...parents, declaration.name]),
  ]);
}

/** The places of the dataset a facet can name, by kind. */
interface Places {
  files: ReadonlySet<string>;
  folders: ReadonlySet<string>;
  packages: ReadonlySet<string>;
  symbols: ReadonlySet<string>;
}

function placesOf(source: DomainsSource): Places {
  const folders = new Set<string>();
  for (const file of source.files) {
    for (
      let folder = folderOf(file);
      folder !== WORKSPACE_ROOT && !folders.has(folder);
      folder = folderOf(folder)
    ) {
      folders.add(folder);
    }
  }
  return {
    files: new Set(source.files),
    folders,
    packages: new Set(source.packages),
    symbols: new Set(source.symbols),
  };
}

/** The kind of place a facet names, or `undefined` when it names none; a package's path is a package before it is a folder. */
function kindOf(facet: string, places: Places): DomainPlaceKind | undefined {
  if (facet.includes("#")) {
    return places.symbols.has(facet) ? "symbol" : undefined;
  }
  if (places.packages.has(facet)) {
    return "package";
  }
  if (places.files.has(facet)) {
    return "file";
  }
  return places.folders.has(facet) ? "folder" : undefined;
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

/**
 * Whether a facet covers a place: a symbol facet only the symbol it names, a
 * path facet everything at or below its path. Coverage runs downward only,
 * so a package is not in a domain for holding one of its facets, and a
 * consumer module, being a file, is covered by path facets alone.
 */
function covers(facet: string, place: string): boolean {
  if (facet.includes("#")) {
    return facet === place;
  }
  const [path = place] = place.split("#");
  return path === facet || path.startsWith(`${facet}/`);
}

/** Every domain a place is in: those whose own facets cover it, and their parents. Nesting is membership. */
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

/**
 * A place's domain label: shared only when every away consumer shares one
 * of its domains, which no unindexed consumer can be shown to.
 */
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

/** A placed place's domains and label, or `undefined` when it is in no domain. */
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
    // A copy: `domainsOf` keeps its array for the next row of this place.
    domains: [...domains],
    level: placement.level,
    package: placement.package,
    place: placement.place,
    placementLabel: placement.label,
    sharedDomains: sorted(shared),
  };
}

/** Whether a package root holds a path; a root at the workspace root holds every path. */
function holds(root: string, path: string): boolean {
  return isWorkspaceRoot(root) || path.startsWith(`${root}/`);
}

function isWorkspaceRoot(root: string): boolean {
  return root === "" || root === WORKSPACE_ROOT;
}

/** How deep a package root sits: 0 at the workspace root, else its number of segments. */
function rootDepth(root: string): number {
  return isWorkspaceRoot(root) ? 0 : root.split("/").length;
}

/**
 * The complete packages whose report can hold a symbol facet's symbol: for
 * each facet's file, the package with the deepest root holding it, in the
 * manifest's order. A file in a package that failed has no report to read.
 */
function packagesNamedBySymbols(
  listed: ReturnType<LensReader["packages"]>,
  facets: readonly string[]
): string[] {
  const owners = new Set<string>();
  for (const facet of facets) {
    const [file, symbol] = facet.split("#");
    if (file === undefined || symbol === undefined) {
      continue;
    }
    const owner = listed
      .filter((pkg) => holds(pkg.path, file))
      .reduce<(typeof listed)[number] | undefined>(
        (deepest, pkg) =>
          deepest === undefined || rootDepth(pkg.path) > rootDepth(deepest.path)
            ? pkg
            : deepest,
        undefined
      );
    if (owner?.status === "complete") {
      owners.add(owner.id);
    }
  }
  return listed.filter((pkg) => owners.has(pkg.id)).map((pkg) => pkg.id);
}

/** Package reports are large, so they are read one at a time, keeping only the symbol ids. */
async function readSymbols(
  reader: LensReader,
  packages: readonly string[]
): Promise<string[]> {
  const symbols: string[] = [];
  for (const id of packages) {
    const report = await reader.packageReport(id);
    for (const symbol of report.symbols) {
      symbols.push(symbol.id);
    }
  }
  return symbols;
}

/**
 * The workspace's declared domains against the dataset: the places each
 * one's facets name, the facets that name none, and the domain label of
 * every placed place inside a domain. A domain never hides an observation:
 * the placement label is kept beside its own, and a facet that matches
 * nothing is reported.
 */
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
  // Path facets are matched against the module index and the package
  // roots alone; only a symbol facet needs a report, its package's.
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
      packages: listed
        .filter((pkg) => pkg.status === "complete")
        .map((pkg) => pkg.path)
        .filter((path) => path !== "" && path !== WORKSPACE_ROOT),
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
