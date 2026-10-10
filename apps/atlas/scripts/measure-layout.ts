/**
 * Measures how the map's layout groups files, the acceptance numbers for
 * 4.3a, against a control that shuffles each island's file positions (and,
 * for row neighbours, each row's order).
 *
 *   bun scripts/measure-layout.ts <dataset output directory>
 *   bun scripts/measure-layout.ts --fixture
 *
 * A dataset is laid out by `loadAtlas` itself, its reads served from disk. A
 * file's district is its responsibility group, from the
 * `responsibility-groups` lens as the layout reads it; its responsibility
 * comes from the island's internals as the map binds them. Each number is
 * given as the map draws it ("drawn"), with every folder's files in path
 * order instead ("path order"), and shuffled. The fixture is the captured
 * renderer input in test/fixtures: its files are laid out again by today's
 * code, and it has no internals or lens, so it reports no district
 * numbers.
 *
 * - folder share: of each file's 3 nearest files on its island, the share in
 *   exactly its directory (a file in a subfolder of it does not count);
 * - district and responsibility shares: the same, over files that have one
 *   (a file of an independent responsibility has no district);
 * - patches per district: the polygons `memberContours` draws for it;
 * - folders per district: the directories each district's files sit in, a
 *   reference for patches per district, which a layout by folder keeps at
 *   or below it when a district is one patch in each folder, or fewer where
 *   its patches in neighbouring cells join; no layout can change it;
 * - row neighbours: of each pair of islands side by side in a layer's row,
 *   the share whose package folders have one parent (`apps/atlas` and
 *   `apps/marbles`), against rows shuffled; read from the manifest, so the
 *   fixture has none;
 * - satellites per package: coast polygons beyond the first, which neither
 *   a shuffle nor the order within folders can change, since both keep the
 *   island's set of positions;
 * - layout: `atlas:data-loaded` to `atlas:layout-settled`, in this process.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { belongingRegions, memberContours } from "../src/web/belonging";
import { districtsOfGroups, settleFiles } from "../src/web/folder-sectors";
import { landContours } from "../src/web/geography";
import { loadAtlas } from "../src/web/load-atlas";
import { loadInternals } from "../src/web/load-internals";
import type { AtlasData, AtlasFile, Territory } from "../src/web/types";

const NEIGHBORS = 3;
/** Where the viewer reads its dataset from, relative to the page. */
const dataMount = /^\.\/data\//;
const SHUFFLES = 10;

interface IslandMeasure {
  /** Each file's district, by file id. */
  districts: ReadonlyMap<string, string>;
  files: AtlasFile[];
  /** Each file's responsibility, by file id. */
  responsibilities: ReadonlyMap<string, string>;
  territory: Territory;
}

interface Numbers {
  districtShare: number | undefined;
  folderShare: number | undefined;
  foldersPerDistrict: number | undefined;
  patchesPerDistrict: number | undefined;
  responsibilityShare: number | undefined;
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

function share({ matched, total }: { matched: number; total: number }) {
  return total ? matched / total : undefined;
}

function tally(
  islands: readonly IslandMeasure[],
  count: (island: IslandMeasure) => { matched: number; total: number }
) {
  return islands
    .map(count)
    .reduce(
      (a, b) => ({ matched: a.matched + b.matched, total: a.total + b.total }),
      { matched: 0, total: 0 }
    );
}

/** Each district's files, by district id. */
function districtMembers(island: IslandMeasure) {
  const members = new Map<string, AtlasFile[]>();
  for (const file of island.files) {
    const district = island.districts.get(file.id);
    if (district !== undefined) {
      members.set(district, [...(members.get(district) ?? []), file]);
    }
  }
  return [...members.values()];
}

function measure(islands: IslandMeasure[]): Numbers {
  const districts = islands.flatMap(districtMembers);
  const mean = (values: number[]) =>
    values.length
      ? values.reduce((total, value) => total + value, 0) / values.length
      : undefined;
  return {
    districtShare: share(
      tally(islands, (island) =>
        nearestShare(island.files, (file) => island.districts.get(file.id))
      )
    ),
    folderShare: share(
      tally(islands, (island) =>
        nearestShare(island.files, (file) => file.directory)
      )
    ),
    foldersPerDistrict: mean(
      districts.map(
        (members) => new Set(members.map((file) => file.directory)).size
      )
    ),
    patchesPerDistrict: mean(
      districts.map((members) => memberContours(members).length)
    ),
    responsibilityShare: share(
      tally(islands, (island) =>
        nearestShare(island.files, (file) =>
          island.responsibilities.get(file.id)
        )
      )
    ),
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
      ? values.reduce((total, value) => total + value, 0) / values.length
      : undefined;
  };
  return {
    districtShare: mean((run) => run.districtShare),
    folderShare: mean((run) => run.folderShare),
    foldersPerDistrict: mean((run) => run.foldersPerDistrict),
    patchesPerDistrict: mean((run) => run.patchesPerDistrict),
    responsibilityShare: mean((run) => run.responsibilityShare),
  };
}

/** The islands laid out again with every folder's files in path order, as without districts. */
function pathOrder(islands: IslandMeasure[]): IslandMeasure[] {
  return islands.map((island) => {
    const files = island.files.map((file) => ({ ...file }));
    settleFiles(files, island.territory.radius, island.territory.folder);
    return { ...island, files };
  });
}

function satellites(territories: Territory[]) {
  const counts = territories.map((p) => Math.max(0, p.coast.length - 1));
  return {
    perPackage:
      counts.reduce((total, count) => total + count, 0) / counts.length,
    total: counts.reduce((total, count) => total + count, 0),
  };
}

function format(value: number | undefined, digits = 3) {
  return (value === undefined ? "n/a" : value.toFixed(digits)).padStart(9);
}

function report(
  name: string,
  islands: IslandMeasure[],
  layoutMs: number | undefined,
  neighbors?: ReturnType<typeof rowNeighbors>
) {
  const drawn = measure(islands);
  const byPath = measure(pathOrder(islands));
  const shuffled = control(islands);
  const moons = satellites(islands.map((island) => island.territory));
  const rows: [string, (numbers: Numbers) => number | undefined][] = [
    ["folder share (3-NN)", (n) => n.folderShare],
    ["district share (3-NN)", (n) => n.districtShare],
    ["responsibility share", (n) => n.responsibilityShare],
    ["patches per district", (n) => n.patchesPerDistrict],
    ["folders per district", (n) => n.foldersPerDistrict],
  ];
  console.info(`${name}: ${islands.length} islands`);
  console.info(`  ${"".padEnd(24)}     drawn path order shuffled`);
  for (const [label, pick] of rows) {
    console.info(
      `  ${label.padEnd(24)}${format(pick(drawn))}${format(pick(byPath))}${format(pick(shuffled))}`
    );
  }
  console.info(
    `  ${"row neighbours, parent".padEnd(24)}${format(neighbors?.laid)}${format(neighbors?.laid)}${format(neighbors?.shuffled)}`
  );
  console.info(
    `  ${"satellites per package".padEnd(24)}${format(moons.perPackage, 2)}   (${moons.total} in all)`
  );
  if (layoutMs !== undefined) {
    console.info(
      `  ${"layout".padEnd(24)}${layoutMs.toFixed(0).padStart(9)} ms`
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
      const groups = territory.responsibilityGroups;
      if (!groups) {
        return {
          districts: new Map(),
          files: territory.files,
          responsibilities: new Map(),
          territory,
        };
      }
      const districtOf = districtsOfGroups(groups.groups);
      const internals = await loadInternals(
        territory.id,
        territory.fileRoles,
        data.generatedAt,
        new AbortController().signal
      );
      const responsibilities = new Map<string, string>();
      for (const region of belongingRegions(internals, territory)) {
        for (const file of region.uncertain ? [] : region.members) {
          if (!responsibilities.has(file.id)) {
            responsibilities.set(file.id, region.id);
          }
        }
      }
      return {
        districts: new Map(
          territory.files.flatMap((file) => {
            const district = districtOf(file);
            return district === undefined ? [] : [[file.id, district]];
          })
        ),
        files: territory.files,
        responsibilities,
        territory,
      };
    })
  );
  const manifest = JSON.parse(
    readFileSync(resolve(root, "manifest.json"), "utf8")
  ) as { packages: { id: string; path: string }[] };
  const paths = new Map(manifest.packages.map((p) => [p.id, p.path]));
  report(root, islands, layoutTime(), rowNeighbors(islandRows(data, paths)));
}

/** The capture's packages all sit two folders deep, as `packages/agents`: the folder its manifest would give. */
function capturedFolder(territory: Pick<Territory, "files">): string {
  return territory.files[0]?.directory.split("/").slice(0, 2).join("/") ?? "";
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
    settleFiles(files, territory.radius, capturedFolder(territory));
    const [, coast = []] = landContours(files, territory.radius);
    return {
      districts: new Map(),
      files,
      responsibilities: new Map(),
      territory: { ...territory, coast, files },
    };
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
