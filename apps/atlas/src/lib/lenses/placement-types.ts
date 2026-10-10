import type { PackageShapeSignal, SurfaceDependencies } from "../types";

/** Bumped when `Placements` changes shape or meaning. */
export const PLACEMENT_SCHEMA_VERSION = 1;

/**
 * The share of a place's consumer modules at which one package holds its
 * use. The lens defines it; the value matches symbol locality's dominant
 * share (`internalLocality.dominantShareThreshold`), which is over consumer
 * modules too. `lib`'s concentrated consumption (0.8, over references and
 * surface) is a different measure, and both stand.
 */
export const PLACEMENT_POLICY = { dominantShare: 0.6 } as const;

/**
 * How a place's use compares with where it lives. `fits`: its own package
 * holds at least the dominant share of its consumer modules. `departs`: one
 * other package does. `spread`: no package does. A package's own modules
 * never count for the package itself, so a package never fits.
 */
export type PlacementLabel = "fits" | "spread" | "departs";

/** What kind of place a placement is about. */
export type PlacementLevel = "symbol" | "file" | "folder" | "package";

/** The consumer modules in one other package. */
interface PlacementAway {
  /** Workspace-relative paths, sorted. */
  modules: string[];
  /**
   * The consumers' package, by manifest id: the module index's package for
   * each consumer file. A consumer in no package of the index (a file of a
   * failed package, or a script at the workspace root) is `unindexed`
   * instead, so this always names a package of the manifest.
   */
  package: string;
}

/** What every placement carries, whatever its label. */
interface PlacementEvidence {
  /** Consumer modules in other packages, the most first, then by package. */
  away: PlacementAway[];
  /** Consumer modules in the place's own package, outside the place; always none for a package. */
  home: { modules: string[] };
  level: PlacementLevel;
  /** The package the place lives in, by manifest id. */
  package: string;
  /** Facet syntax: `path#name` for a symbol, else the workspace-relative path of the file, folder, or package root. */
  place: string;
  /** Consumer modules in no package of the module index; counted, never labelled. */
  unindexed: number;
}

/**
 * One place's label and the evidence for it. A place is an exported symbol
 * declared in a source file, a source file, a folder, or a package; a symbol
 * its module does not export is not placed, since nothing outside its module
 * can use it. A consumer module is a source file outside the place that
 * uses it, by the module index's kind. At home it imports the symbol
 * through a primary edge of the package's topology, type-only imports
 * included; away it references the symbol at least once beyond its import.
 * The two are comparable because each counts a distinct module once,
 * however often it uses the symbol, and each leaves out a module that only
 * forwards the symbol (`export … from`), so a barrel earns no use on either
 * side. They differ only for an import never used, which counts at home and
 * not away. A place that departs names the package it departs toward.
 */
export type Placement = PlacementEvidence &
  (
    | { label: "fits" | "spread" }
    | {
        label: "departs";
        /** The package holding the dominant share, by manifest id. */
        toward: string;
      }
  );

/** How many of one level's places got each label, and how many no consumer uses. */
export type PlacementCounts = Record<PlacementLabel | "unconsumed", number>;

/** One package whose places the lens labelled. */
export interface PlacementPackage {
  counts: Record<PlacementLevel, PlacementCounts>;
  /** By manifest id. */
  id: string;
  /** Workspace-relative path of the package root, its place. */
  path: string;
  /** The package's leading consumer, as its report measures it (over references and surface); for cross-checking the package's own placement. */
  primaryConsumer?: NonNullable<SurfaceDependencies["primaryConsumer"]>;
  /** The package's shape signals, copied from its report. */
  shapeSignals: PackageShapeSignal[];
  /**
   * Distinct files outside the module index that consume any of the
   * package's places. Mostly the files of a package that failed, since the
   * module index holds only packages that produced a report, and scripts at
   * the workspace root. An unindexed file has no kind, so it cannot be told
   * apart from a test; it counts here as a possible consumer, and never in a
   * label.
   */
  unindexed: number;
}

/**
 * The `placement` lens. `places` holds every place with a consumer module in
 * another package, sorted by place, then level, then package; every other
 * place is only counted.
 * `packages` holds every package with internals, sorted by id; `missing` the
 * complete packages without them, whose places it cannot label, since their
 * home use is unknown. A package that failed is in neither.
 */
export interface Placements {
  missing: string[];
  packages: PlacementPackage[];
  places: Placement[];
  policy: { dominantShare: number };
}
