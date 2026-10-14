import type {
  InternalConsumedSymbol,
  InternalModuleNode,
  InternalPackageTopology,
} from "../internal-topology-types";
import type { SemanticsModuleIndexEntry } from "../semantics-types";
import type { ConsumerModuleUsage, SurfaceDependencies } from "../types";
import { byId } from "../workspace-projection";
import type { Lens } from "./lens-types";
import { readPackageInternals, rootRelative } from "./package-internals";
import type {
  Placement,
  PlacementCounts,
  PlacementLabel,
  PlacementLevel,
  PlacementPackage,
} from "./placement-types";
import { PLACEMENT_POLICY, PLACEMENT_SCHEMA_VERSION } from "./placement-types";

/** A package report's symbol, by the fields the lens reads. */
interface PlacementSourceSymbol {
  consumerModuleUsage: Pick<ConsumerModuleUsage, "module" | "references">[];
  declarationFile: string;
  exported: boolean;
  id: string;
}

/** One package with internals; topology ids are the package's own, report ids root-relative. */
export interface PlacementSourcePackage {
  dependencies: Pick<SurfaceDependencies, "primaryConsumer" | "shapeSignals">;
  id: string;
  root: string;
  symbols: PlacementSourceSymbol[];
  topology: {
    consumedSurface: (Pick<InternalConsumedSymbol, "symbolId"> & {
      consumers: { module: string }[];
    })[];
    directories: { id: string }[];
    modules: Pick<InternalModuleNode, "id" | "fileKind">[];
    policy: Pick<InternalPackageTopology["policy"], "technicalRoots">;
  };
}

/** Every dataset field the lens reads. */
export interface PlacementSource {
  missing: string[];
  modules: Pick<SemanticsModuleIndexEntry, "id" | "package" | "fileKind">[];
  packages: PlacementSourcePackage[];
}

/** Where a place's consumer modules are: home, by other package, or in no indexed package. */
interface Consumers {
  away: Map<string, Set<string>>;
  home: Set<string>;
  unindexed: Set<string>;
}

type ModuleIndex = ReadonlyMap<
  string,
  Pick<SemanticsModuleIndexEntry, "package" | "fileKind">
>;

function noConsumers(): Consumers {
  return { away: new Map(), home: new Set(), unindexed: new Set() };
}

function addAll(into: Set<string>, from: Iterable<string>): void {
  for (const value of from) {
    into.add(value);
  }
}

function merge(into: Consumers, from: Consumers): void {
  addAll(into.home, from.home);
  addAll(into.unindexed, from.unindexed);
  for (const [pkg, modules] of from.away) {
    const kept = into.away.get(pkg) ?? new Set<string>();
    addAll(kept, modules);
    into.away.set(pkg, kept);
  }
}

function noCounts(): PlacementCounts {
  return { departs: 0, fits: 0, spread: 0, unconsumed: 0 };
}

/**
 * Each exported symbol declared in one of the package's source files, by id,
 * with its consumer modules: home from the topology's consumed surface, away
 * from the report's consumer modules that reference it. A symbol its module
 * does not export is not placed, since nothing outside the module can use it.
 * Two declarations sharing an id (an interface and a const of one name) are
 * one place.
 */
function symbolConsumers(
  pkg: PlacementSourcePackage,
  sourceFiles: ReadonlySet<string>,
  index: ModuleIndex
): Map<string, { consumers: Consumers; file: string }> {
  const symbols = new Map<string, { consumers: Consumers; file: string }>();
  for (const symbol of pkg.symbols) {
    if (!(symbol.exported && sourceFiles.has(symbol.declarationFile))) {
      continue;
    }
    const entry = symbols.get(symbol.id) ?? {
      consumers: noConsumers(),
      file: symbol.declarationFile,
    };
    symbols.set(symbol.id, entry);
    for (const usage of symbol.consumerModuleUsage) {
      // An entry with no reference imports the symbol without using it:
      // only to forward it (`export … from`), or never at all.
      if (usage.references > 0) {
        placeConsumer(entry.consumers, usage.module, pkg.id, index);
      }
    }
  }
  for (const consumed of pkg.topology.consumedSurface) {
    const entry = symbols.get(consumed.symbolId);
    if (entry === undefined) {
      continue;
    }
    for (const consumer of consumed.consumers) {
      entry.consumers.home.add(rootRelative(pkg.root, consumer.module));
    }
  }
  return symbols;
}

/** Files the module index does not hold are unindexed; files of another kind than source are no consumers. */
function placeConsumer(
  consumers: Consumers,
  module: string,
  home: string,
  index: ModuleIndex
): void {
  const indexed = index.get(module);
  if (indexed === undefined) {
    consumers.unindexed.add(module);
    return;
  }
  if (indexed.fileKind !== "source") {
    return;
  }
  if (indexed.package === home) {
    consumers.home.add(module);
    return;
  }
  const modules = consumers.away.get(indexed.package) ?? new Set<string>();
  modules.add(module);
  consumers.away.set(indexed.package, modules);
}

/** A label, with the package a departing place departs toward. */
type Labelled =
  | { label: "fits" | "spread" }
  | { label: "departs"; toward: string };

/** The label the consumer modules give, or `undefined` when there are none. */
function labelOf(
  home: number,
  away: readonly { modules: readonly string[]; package: string }[]
): Labelled | undefined {
  const total = away.reduce((sum, pkg) => sum + pkg.modules.length, home);
  if (total === 0) {
    return;
  }
  const [leading] = away;
  const { dominantShare } = PLACEMENT_POLICY;
  if (
    leading !== undefined &&
    leading.modules.length / total >= dominantShare
  ) {
    return { label: "departs", toward: leading.package };
  }
  return { label: home / total >= dominantShare ? "fits" : "spread" };
}

/** One place's label, and its placement when something away uses it. */
function placeOf(
  place: { level: PlacementLevel; package: string; place: string },
  consumers: Consumers,
  isInside: (module: string) => boolean
): { label: PlacementLabel | "unconsumed"; placement?: Placement } {
  const home = [...consumers.home].filter((module) => !isInside(module));
  const away = [...consumers.away]
    .map(([pkg, modules]) => ({
      modules: [...modules].sort(byId),
      package: pkg,
    }))
    .sort(
      (a, b) =>
        b.modules.length - a.modules.length || byId(a.package, b.package)
    );
  const labelled = labelOf(home.length, away);
  if (labelled === undefined) {
    return { label: "unconsumed" };
  }
  if (away.length === 0) {
    return { label: labelled.label };
  }
  return {
    label: labelled.label,
    placement: {
      away,
      home: { modules: home.sort(byId) },
      level: place.level,
      package: place.package,
      place: place.place,
      unindexed: consumers.unindexed.size,
      ...labelled,
    },
  };
}

/** A package's folders, root-relative: every directory but its root and a technical root such as `src`, which only restate the package. */
function foldersOf(pkg: PlacementSourcePackage): string[] {
  const technical = new Set(pkg.topology.policy.technicalRoots);
  return pkg.topology.directories
    .filter(({ id }) => id !== "." && !technical.has(id))
    .map(({ id }) => rootRelative(pkg.root, id));
}

function derivePackage(
  pkg: PlacementSourcePackage,
  index: ModuleIndex
): { entry: PlacementPackage; places: Placement[] } {
  const files = pkg.topology.modules
    .filter((module) => module.fileKind === "source")
    .map((module) => rootRelative(pkg.root, module.id));
  const symbols = symbolConsumers(pkg, new Set(files), index);
  const folders = foldersOf(pkg);
  const byFile = new Map(files.map((file) => [file, noConsumers()]));
  const byFolder = new Map(folders.map((folder) => [folder, noConsumers()]));
  const whole = noConsumers();
  const counts: Record<PlacementLevel, PlacementCounts> = {
    file: noCounts(),
    folder: noCounts(),
    package: noCounts(),
    symbol: noCounts(),
  };
  const places: Placement[] = [];
  /** Counts the place under its label, and keeps its placement if it has one. */
  const place = (
    level: PlacementLevel,
    id: string,
    consumers: Consumers,
    isInside: (module: string) => boolean
  ) => {
    const { label, placement } = placeOf(
      { level, package: pkg.id, place: id },
      consumers,
      isInside
    );
    counts[level][label] += 1;
    if (placement !== undefined) {
      places.push(placement);
    }
  };

  for (const [id, { consumers, file }] of symbols) {
    place("symbol", id, consumers, () => false);
    const fileConsumers = byFile.get(file);
    if (fileConsumers !== undefined) {
      merge(fileConsumers, consumers);
    }
    for (const [folder, folderConsumers] of byFolder) {
      if (file.startsWith(`${folder}/`)) {
        merge(folderConsumers, consumers);
      }
    }
    merge(whole, consumers);
  }
  for (const [file, consumers] of byFile) {
    place("file", file, consumers, (module) => module === file);
  }
  for (const [folder, consumers] of byFolder) {
    place("folder", folder, consumers, (module) =>
      module.startsWith(`${folder}/`)
    );
  }
  // Every home module is inside the package, so a package never fits.
  place("package", pkg.root, whole, () => true);

  const { primaryConsumer, shapeSignals } = pkg.dependencies;
  return {
    entry: {
      counts,
      id: pkg.id,
      path: pkg.root,
      ...(primaryConsumer !== undefined && { primaryConsumer }),
      shapeSignals: [...shapeSignals],
      unindexed: whole.unindexed.size,
    },
    places,
  };
}

/** Only the symbol fields the lens reads, so a package report is not kept once read. */
function projectSymbols(
  symbols: readonly PlacementSourceSymbol[]
): PlacementSourceSymbol[] {
  return symbols.map(
    ({ consumerModuleUsage, declarationFile, exported, id }) => ({
      consumerModuleUsage: consumerModuleUsage.map(
        ({ module, references }) => ({ module, references })
      ),
      declarationFile,
      exported,
      id,
    })
  );
}

/**
 * Where each place is used against where it lives, at four levels: each
 * symbol, file, and folder of a package with internals, and the package.
 * A place's consumer modules are the symbols' own, so a barrel that only
 * forwards a symbol earns none of its use; a file's or folder's are the
 * union over the symbols declared in it, less the modules inside it. The
 * labels are observations: nothing here calls a place misplaced.
 */
export const placementLens: Lens<"placement", PlacementSource> = {
  derive: ({ missing, modules, packages }) => {
    const index: ModuleIndex = new Map(
      modules.map((module) => [module.id, module])
    );
    const derived = packages.map((pkg) => derivePackage(pkg, index));
    return {
      missing,
      packages: derived
        .map(({ entry }) => entry)
        .sort((a, b) => byId(a.id, b.id)),
      places: derived
        .flatMap(({ places }) => places)
        .sort(
          (a, b) =>
            byId(a.place, b.place) ||
            byId(a.level, b.level) ||
            byId(a.package, b.package)
        ),
      policy: { dominantShare: PLACEMENT_POLICY.dominantShare },
    };
  },
  id: "placement",
  // Package reports are large, so they are read one at a time and only the
  // symbol and dependency fields are kept; the lens reader does not cache them.
  read: async (reader) => {
    const [index, { missing, packages: withInternals }] = await Promise.all([
      reader.moduleIndex(),
      readPackageInternals(reader),
    ]);
    const packages: PlacementSourcePackage[] = [];
    for (const { id, internals, root } of withInternals) {
      const { dependencies, symbols } = await reader.packageReport(id);
      const { consumedSurface, directories, modules, policy } =
        internals.topology;
      packages.push({
        dependencies: {
          ...(dependencies.primaryConsumer !== undefined && {
            primaryConsumer: { ...dependencies.primaryConsumer },
          }),
          shapeSignals: [...dependencies.shapeSignals],
        },
        id,
        root,
        symbols: projectSymbols(symbols),
        topology: {
          consumedSurface: consumedSurface.map(({ consumers, symbolId }) => ({
            consumers: consumers.map(({ module }) => ({ module })),
            symbolId,
          })),
          directories: directories.map(({ id: directory }) => ({
            id: directory,
          })),
          modules: modules.map(({ fileKind, id: module }) => ({
            fileKind,
            id: module,
          })),
          policy: { technicalRoots: [...policy.technicalRoots] },
        },
      });
    }
    return {
      missing,
      modules: index.modules.map(({ fileKind, id, package: pkg }) => ({
        id,
        package: pkg,
        ...(fileKind !== undefined && { fileKind }),
      })),
      packages,
    };
  },
  schemaVersion: PLACEMENT_SCHEMA_VERSION,
  settings: [],
};
