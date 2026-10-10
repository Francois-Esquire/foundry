/**
 * Measures how the map's layout groups files, the acceptance numbers for
 * 4.3a, against a control that shuffles each island's file positions (and,
 * for row neighbours, each row's order).
 *
 *   bun scripts/measure-layout.ts <dataset output directory>
 *   bun scripts/measure-layout.ts --fixture
 *
 * A dataset is laid out by `loadAtlas` itself, its reads served from disk,
 * and each island's districts come from its internals as the map binds them.
 * The fixture is the captured renderer input in test/fixtures: its files are
 * laid out again by today's code, and it has no internals, so it reports no
 * district numbers.
 *
 * - folder share: of each file's 3 nearest files on its island, the share in
 *   exactly its directory (a file in a subfolder of it does not count);
 * - district share: of each districted file's 3 nearest districted files,
 *   the share in its district (`unresolved:` regions are not districts);
 * - patches per district: the polygons `memberContours` draws for it;
 * - row neighbours: of each pair of islands side by side in a layer's row,
 *   the share whose package folders have one parent (`apps/atlas` and
 *   `apps/marbles`), against rows shuffled; read from the manifest, so the
 *   fixture has none;
 * - satellites per package: coast polygons beyond the first, which a
 *   shuffle cannot change, since it keeps the island's set of positions;
 * - layout: `atlas:data-loaded` to `atlas:layout-settled`, in this process.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BelongingRegion } from "../src/web/belonging";
import { belongingRegions, memberContours } from "../src/web/belonging";
import { landContours, settleFiles } from "../src/web/geography";
import { loadAtlas } from "../src/web/load-atlas";
import { loadInternals } from "../src/web/load-internals";
import type { AtlasData, AtlasFile, Territory } from "../src/web/types";

const NEIGHBORS = 3;
/** Where the viewer reads its dataset from, relative to the page. */
const dataMount = /^\.\/data\//;
const SHUFFLES = 10;

interface IslandMeasure {
  districts: BelongingRegion[];
  files: AtlasFile[];
  territory: Territory;
}

interface Numbers {
  districtShare: number | undefined;
  folderShare: number;
  patchesPerDistrict: number | undefined;
}

/** A seeded generator, so the control is the same on every run. */
function random(seed: number) {
  let state = seed;
  return () => {
    // biome-ignore lint/suspicious/noBitwiseOperators: mulberry32 works on 32-bit integers.
    state = (state + 0x6d_2b_79_f5) | 0;
    let t = state;
    // biome-ignore lint/suspicious/noBitwiseOperators: mulberry32 works on 32-bit integers.
    t = Math.imul(t ^ (t >>> 15), t | 1);
    // biome-ignore lint/suspicious/noBitwiseOperators: mulberry32 works on 32-bit integers.
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    // biome-ignore lint/suspicious/noBitwiseOperators: mulberry32 works on 32-bit integers.
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** The same files, each moved to another file's position on the island. */
function shuffle(files: AtlasFile[], next: () => number): AtlasFile[] {
  const spots = permute(
    files.map(({ x, y }) => ({ x, y })),
    next
  );
  return files.map((file, i) => ({ ...file, ...spots[i] }));
}

/** The items in a random order (Fisher–Yates). */
function permute<T>(items: readonly T[], next: () => number): T[] {
  const order = [...items];
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    const a = order[i];
    const b = order[j];
    if (a !== undefined && b !== undefined) {
      order[i] = b;
      order[j] = a;
    }
  }
  return order;
}

/** A package path's parent folder: `apps` for `apps/atlas`, empty for `docs`. */
function parentFolder(path: string) {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
}

/** Each layer's islands, west to east, as their package folders' parents. */
function islandRows(data: AtlasData, paths: ReadonlyMap<string, string>) {
  const rows = new Map<number, Territory[]>();
  for (const territory of data.territories) {
    const layer = data.packageLayers[territory.id] ?? 0;
    rows.set(layer, [...(rows.get(layer) ?? []), territory]);
  }
  return [...rows.values()].map((row) =>
    [...row]
      .sort((a, b) => a.x - b.x)
      .map((territory) => parentFolder(paths.get(territory.id) ?? ""))
  );
}

/** Of each pair of islands side by side in a row, the share whose folders have one parent. */
function rowNeighborShare(rows: readonly string[][]): number | undefined {
  let matched = 0;
  let total = 0;
  for (const row of rows) {
    for (const [i, parent] of row.slice(1).entries()) {
      total += 1;
      matched += parent === row[i] ? 1 : 0;
    }
  }
  return total ? matched / total : undefined;
}

/** The row-neighbour share as laid out, and over rows put in a random order. */
function rowNeighbors(rows: readonly string[][]) {
  const next = random(4301);
  const shuffled = Array.from(
    { length: SHUFFLES },
    () => rowNeighborShare(rows.map((row) => permute(row, next))) ?? 0
  );
  return {
    laid: rowNeighborShare(rows),
    shuffled: shuffled.reduce((sum, value) => sum + value, 0) / SHUFFLES,
  };
}

/** Of each file's nearest files, the share with the same group; files without a group are skipped. */
function nearestShare(
  files: AtlasFile[],
  group: (file: AtlasFile) => string | undefined
): { matched: number; total: number } {
  const grouped = files.filter((file) => group(file) !== undefined);
  let matched = 0;
  let total = 0;
  for (const file of grouped) {
    const nearest = grouped
      .filter((other) => other !== file)
      .map((other) => ({
        distance: (other.x - file.x) ** 2 + (other.y - file.y) ** 2,
        other,
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, NEIGHBORS);
    for (const { other } of nearest) {
      total += 1;
      matched += group(other) === group(file) ? 1 : 0;
    }
  }
  return { matched, total };
}

function measure(islands: IslandMeasure[]): Numbers {
  let folders = { matched: 0, total: 0 };
  let districts = { matched: 0, total: 0 };
  let patches = 0;
  let districtCount = 0;
  for (const { districts: regions, files } of islands) {
    const placed = new Map(files.map((file) => [file.id, file]));
    const district = new Map<string, string>();
    for (const region of regions) {
      for (const member of region.members) {
        district.set(member.id, region.id);
      }
      patches += memberContours(
        region.members.flatMap((member) => placed.get(member.id) ?? [])
      ).length;
      districtCount += 1;
    }
    const folder = nearestShare(files, (file) => file.directory);
    folders = {
      matched: folders.matched + folder.matched,
      total: folders.total + folder.total,
    };
    const near = nearestShare(files, (file) => district.get(file.id));
    districts = {
      matched: districts.matched + near.matched,
      total: districts.total + near.total,
    };
  }
  return {
    districtShare: districts.total
      ? districts.matched / districts.total
      : undefined,
    folderShare: folders.total ? folders.matched / folders.total : 0,
    patchesPerDistrict: districtCount ? patches / districtCount : undefined,
  };
}

function control(islands: IslandMeasure[]): Numbers {
  const next = random(4300);
  const runs = Array.from({ length: SHUFFLES }, () =>
    measure(
      islands.map((island) => ({
        ...island,
        files: shuffle(island.files, next),
      }))
    )
  );
  const mean = (pick: (numbers: Numbers) => number | undefined) => {
    const values = runs.flatMap((run) => pick(run) ?? []);
    return values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : undefined;
  };
  return {
    districtShare: mean((run) => run.districtShare),
    folderShare: mean((run) => run.folderShare) ?? 0,
    patchesPerDistrict: mean((run) => run.patchesPerDistrict),
  };
}

function satellites(territories: Territory[]) {
  const counts = territories.map((p) => Math.max(0, p.coast.length - 1));
  return {
    perPackage: counts.reduce((sum, count) => sum + count, 0) / counts.length,
    total: counts.reduce((sum, count) => sum + count, 0),
  };
}

function format(value: number | undefined, digits = 3) {
  return value === undefined ? "n/a" : value.toFixed(digits);
}

function report(
  name: string,
  islands: IslandMeasure[],
  layoutMs: number | undefined,
  neighbors?: ReturnType<typeof rowNeighbors>
) {
  const laid = measure(islands);
  const shuffled = control(islands);
  const moons = satellites(islands.map((island) => island.territory));
  const rows = [
    ["folder share (3-NN)", laid.folderShare, shuffled.folderShare],
    ["district share (3-NN)", laid.districtShare, shuffled.districtShare],
    [
      "patches per district",
      laid.patchesPerDistrict,
      shuffled.patchesPerDistrict,
    ],
    ["row neighbours, parent", neighbors?.laid, neighbors?.shuffled],
  ] as const;
  console.info(`${name}: ${islands.length} islands`);
  for (const [label, value, controlValue] of rows) {
    console.info(
      `  ${label.padEnd(24)} ${format(value).padStart(7)}   shuffled ${format(controlValue).padStart(7)}`
    );
  }
  console.info(
    `  ${"satellites per package".padEnd(24)} ${format(moons.perPackage, 2).padStart(7)}   (${moons.total} in all)`
  );
  if (layoutMs !== undefined) {
    console.info(
      `  ${"layout".padEnd(24)} ${layoutMs.toFixed(0).padStart(7)} ms`
    );
  }
}

/** Serves `./data/` from a dataset directory, as `atlas serve` mounts it. */
function serveFromDisk(root: string) {
  globalThis.fetch = ((url: string) => {
    const path = String(url).replace(dataMount, "");
    try {
      return Promise.resolve(
        new Response(readFileSync(resolve(root, path), "utf8"))
      );
    } catch {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
  }) as typeof fetch;
}

function layoutTime() {
  const [loaded] = performance.getEntriesByName("atlas:data-loaded");
  const [settled] = performance.getEntriesByName("atlas:layout-settled");
  return loaded && settled ? settled.startTime - loaded.startTime : undefined;
}

async function measureDataset(root: string) {
  serveFromDisk(root);
  const data = await loadAtlas();
  const islands = await Promise.all(
    data.territories.map(async (territory): Promise<IslandMeasure> => {
      const internals = territory.responsibilityGroups
        ? await loadInternals(
            territory.id,
            territory.fileRoles,
            data.generatedAt,
            new AbortController().signal
          )
        : undefined;
      const districts = internals
        ? belongingRegions(internals, territory).filter(
            (region) => !region.uncertain
          )
        : [];
      return { districts, files: territory.files, territory };
    })
  );
  const manifest = JSON.parse(
    readFileSync(resolve(root, "manifest.json"), "utf8")
  ) as { packages: { id: string; path: string }[] };
  const paths = new Map(manifest.packages.map((p) => [p.id, p.path]));
  report(root, islands, layoutTime(), rowNeighbors(islandRows(data, paths)));
}

function measureFixture() {
  const data = JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, "../test/fixtures/atlas.json"),
      "utf8"
    )
  ) as AtlasData;
  const islands = data.territories.map((territory): IslandMeasure => {
    const files = territory.files.map((file) => ({ ...file, x: 0, y: 0 }));
    settleFiles(files, territory.radius, data.fileEdges);
    const [, coast = []] = landContours(files, territory.radius);
    return { districts: [], files, territory: { ...territory, coast, files } };
  });
  report("fixture", islands, undefined);
}

const [target] = process.argv.slice(2);
if (target === "--fixture") {
  measureFixture();
} else if (target) {
  await measureDataset(resolve(target));
} else {
  throw new Error(
    "Pass a dataset's output directory, or --fixture for the test fixture."
  );
}
