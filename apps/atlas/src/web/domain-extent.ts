import { byCodeUnit } from "@foundry/lib/ordering";
import { covers } from "../lib/facet-cover";
import { type FolderCell, folderWithin } from "./folder-sectors";
import type { AtlasData, AtlasFile, AtlasFrame, Territory } from "./types";

/**
 * A declared domain, by the frame that declares it and its name there: a
 * name is unique within one workspace's configuration only.
 */
export interface DomainRef {
  frame: string;
  name: string;
}

/** What a domain covers on one island. */
export interface DomainIsland {
  /**
   * The topmost folder cells it covers, none below another. Empty when it
   * covers the island whole.
   */
  cells: FolderCell[];
  /** How many of the island's files it covers. */
  covered: number;
  /** Files it names alone, outside every covered cell. */
  files: AtlasFile[];
  territory: Territory;
  /** Covered whole: by a package facet, or a folder facet above the package. */
  whole: boolean;
}

/**
 * Where a domain lies across the islands, from its own facets and those of
 * every domain nested in it, since a place in a nested domain is in its
 * parent too.
 */
export interface DomainExtent {
  /** Domain departures inside it: some consumer module shares none of its domains. */
  departures: number;
  /**
   * The placed places it explains: departures whose domain label is
   * `shares-domain` with this domain among the shared, keyed `level:place`.
   */
  explained: ReadonlySet<string>;
  /** The frame that declares it, by id. */
  frame: string;
  /** Islands it covers some of, in the atlas's order. */
  islands: DomainIsland[];
  name: string;
  /** Its symbol facets, which the map does not draw. */
  symbols: string[];
  /** Facets of it and its nested domains that match no place. */
  unmatched: string[];
}

const byText = byCodeUnit((text: string) => text);

/** Whether a package's folder holds a path: every path, for a package at the workspace root. */
function holds(folder: string, path: string): boolean {
  return folder === "" || covers(folder, path);
}

/** The cell of `folder`, below the package, in an island's cell tree. */
function cellOf(tree: FolderCell, folder: string): FolderCell | undefined {
  if (tree.folder === folder) {
    return tree;
  }
  for (const cell of tree.folders) {
    if (folder === cell.folder || folder.startsWith(`${cell.folder}/`)) {
      return cellOf(cell, folder);
    }
  }
}

/** A cell's folder as a workspace path. */
function cellPath(territory: Territory, cell: FolderCell): string {
  return [territory.folder, cell.folder].filter(Boolean).join("/");
}

/** The package that holds a path: the one with the deepest folder holding it. */
function ownerOf(
  territories: readonly Territory[],
  path: string
): Territory | undefined {
  let owner: Territory | undefined;
  for (const territory of territories) {
    if (
      holds(territory.folder, path) &&
      territory.folder.length >= (owner?.folder.length ?? -1)
    ) {
      owner = territory;
    }
  }
  return owner;
}

interface Claims {
  cells: FolderCell[];
  files: AtlasFile[];
  whole: boolean;
}

/** Puts one path facet's claim on the islands it reaches. */
function claimPath(
  data: Pick<AtlasData, "folderCells" | "territories">,
  claims: Map<string, Claims>,
  facet: { kind: string; place: string }
): void {
  const claim = (island: Territory) => {
    const known = claims.get(island.id) ?? {
      cells: [],
      files: [],
      whole: false,
    };
    claims.set(island.id, known);
    return known;
  };
  const whole = data.territories.filter(
    (island) => island.folder && covers(facet.place, island.folder)
  );
  if (whole.length) {
    for (const island of whole) {
      claim(island).whole = true;
    }
    return;
  }
  const territory = ownerOf(data.territories, facet.place);
  if (!territory) {
    return;
  }
  const file = territory.files.find((item) => item.path === facet.place);
  if (file) {
    claim(territory).files.push(file);
    return;
  }
  const tree = data.folderCells[territory.id];
  const cell =
    facet.kind === "folder" && tree && tree.spatial !== "cluster"
      ? cellOf(tree, folderWithin(facet.place, territory.folder))
      : undefined;
  if (cell) {
    claim(territory).cells.push(cell);
    return;
  }
  // A folder with no cell of its own (no cell tree, or none for it): its files.
  const files = territory.files.filter((item) =>
    covers(facet.place, item.path)
  );
  if (files.length) {
    claim(territory).files.push(...files);
  }
}

/** One island's claims with nothing drawn twice: no cell below another, no file inside a cell. */
function settleIsland(territory: Territory, claims: Claims): DomainIsland {
  if (claims.whole) {
    return {
      cells: [],
      covered: territory.files.length,
      files: [],
      territory,
      whole: true,
    };
  }
  const unique = [...new Set(claims.cells)];
  const paths = unique.map((cell) => cellPath(territory, cell));
  // Two cells never share a folder, so a path covering another is above it.
  const cells = unique.filter(
    (_, i) => !paths.some((path, j) => j !== i && covers(path, paths[i] ?? ""))
  );
  const topPaths = cells.map((cell) => cellPath(territory, cell));
  const inCell = (file: AtlasFile) =>
    topPaths.some((path) => covers(path, file.path));
  const files = [...new Set(claims.files)]
    .filter((file) => !inCell(file))
    .sort((a, b) => byText(a.path, b.path));
  const covered = territory.files.filter(inCell).length + files.length;
  return { cells, covered, files, territory, whole: false };
}

const computed = new WeakMap<AtlasData, Map<string, DomainExtent | null>>();

/**
 * Where a declared domain lies across its frame's islands: the islands it
 * covers whole, the topmost folder cells and the lone files it covers on
 * the others, its symbols, its unmatched facets, and the departures it
 * explains; `null` for a domain its frame does not declare. Deterministic,
 * and worked out once per atlas and domain.
 */
export function domainExtent(
  data: AtlasData,
  domain: DomainRef
): DomainExtent | null {
  const known = computed.get(data) ?? new Map<string, DomainExtent | null>();
  computed.set(data, known);
  const key = JSON.stringify([domain.frame, domain.name]);
  const cached = known.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const frame = data.frames.find((item) => item.id === domain.frame);
  const extent = frame ? resolveExtent(data, frame, domain.name) : null;
  known.set(key, extent);
  return extent;
}

function resolveExtent(
  data: AtlasData,
  frame: AtlasFrame,
  name: string
): DomainExtent | null {
  const { domains } = frame.readings;
  const { declared } = domains;
  if (!declared.some((domain) => domain.name === name)) {
    return null;
  }
  const members = declared.filter(
    (domain) => domain.name === name || domain.parents.includes(name)
  );
  // Its own frame's islands only: its facets are that workspace's paths.
  const own = {
    folderCells: data.folderCells,
    territories: data.territories.filter((territory) =>
      frame.territories.includes(territory.id)
    ),
  };
  const claims = new Map<string, Claims>();
  const symbols = new Set<string>();
  for (const facet of members.flatMap((domain) => domain.places)) {
    if (facet.kind === "symbol") {
      symbols.add(facet.place);
    } else {
      claimPath(own, claims, facet);
    }
  }
  const islands = own.territories.flatMap((territory) => {
    const claim = claims.get(territory.id);
    return claim ? [settleIsland(territory, claim)] : [];
  });
  const placed = Object.entries(domains.placements);
  return {
    departures: placed.filter(
      ([, place]) =>
        place.domainLabel === "departs" && place.domains.includes(name)
    ).length,
    explained: new Set(
      placed
        .filter(
          ([, place]) =>
            place.domainLabel === "shares-domain" &&
            place.sharedDomains.includes(name)
        )
        .map(([key]) => key)
    ),
    frame: frame.id,
    islands,
    name,
    symbols: [...symbols].sort(byText),
    unmatched: [...new Set(members.flatMap((domain) => domain.unmatched))].sort(
      byText
    ),
  };
}
