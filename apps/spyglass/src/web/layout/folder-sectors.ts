import { byCodeUnit } from "@foundry/lib/ordering";
import type { ResponsibilityGroup } from "../../lib/lenses/responsibility-groups-types";
import { unit } from "../../lib/visualization/geography";
import { contourSigma } from "../../lib/visualization/island-geometry";
import type {
  CellSplit,
  FolderCell,
  Rect,
  Site,
  SpyglassFile,
} from "../data/types";

/**
 * Files inside an island, placed by the folder tree alone. Each file gets a
 * site of a sunflower lattice filling a lobed footprint. The package's folder tree
 * divides the sites: every folder takes a convex cell sized by its files,
 * sibling folders side by side in name order, a folder's own files before
 * its subfolders. A small gutter parts the cells at each split, widest at
 * the first, so folders read in the specks. Within a folder, files take its
 * sites by district, so each district is one patch per folder. Imports play
 * no part.
 */

interface FolderNode {
  /** Files directly in the folder. */
  files: SpyglassFile[];
  folders: Map<string, FolderNode>;
  /** Files in the folder and below it. */
  size: number;
}

/** A folder's own files, as one block, or one of its subfolders. */
type Block =
  | { files: SpyglassFile[] }
  | { folder: string; parts: Block[]; size: number };

/** Lattice spacing as a share of the contour spread: close enough that one folder's files make one piece of land. */
const spacingPerSigma = 1.5;
/**
 * The widest spacing: a district's footprint (`memberContours`) reaches
 * about 4.9 units round each file, so neighbours further apart than about
 * 9.8 units would draw as separate patches of one district.
 */
const widestSpacing = 8;
/** The gutter at the island's first split, in lattice spacings; it halves at each split below. */
const topGutter = 1;
/** Sunflower lattice: the golden angle, and the radius step giving neighbours one spacing apart. */
const goldenAngle = Math.PI * (3 - Math.sqrt(5));
const spacingPerRadiusStep = Math.sqrt((2 * Math.PI) / Math.sqrt(3));

const byPath = byCodeUnit((file: SpyglassFile) => file.path);
const byName = byCodeUnit(([name]: [string, FolderNode]) => name);
const byDistrictId = byCodeUnit(([district]: [string, number]) => district);
const byGroupId = byCodeUnit(
  (group: Pick<ResponsibilityGroup, "id">) => group.id
);

/** A file's folder below the package's: "" for a file at the package root. */
export function folderWithin(directory: string, root: string): string {
  if (directory === root) {
    return "";
  }
  return root && directory.startsWith(`${root}/`)
    ? directory.slice(root.length + 1)
    : directory;
}

function folderTree(files: readonly SpyglassFile[], root: string): FolderNode {
  const tree: FolderNode = { files: [], folders: new Map(), size: 0 };
  for (const file of files) {
    let node = tree;
    node.size += 1;
    const within = folderWithin(file.directory, root);
    for (const name of within ? within.split("/") : []) {
      const next = node.folders.get(name) ?? {
        files: [],
        folders: new Map(),
        size: 0,
      };
      node.folders.set(name, next);
      node = next;
      node.size += 1;
    }
    node.files.push(file);
  }
  return tree;
}

/** How a folder's own files take its sites: by district, then path, or by path alone. */
type FileOrder = (a: SpyglassFile, b: SpyglassFile) => number;

/** A folder's blocks, its own files in `order` first, then its subfolders by name, each as blocks in turn. */
function blocks(node: FolderNode, order: FileOrder, path = ""): Block[] {
  const own: Block[] = node.files.length
    ? [{ files: [...node.files].sort(order) }]
    : [];
  return [
    ...own,
    ...[...node.folders].sort(byName).map(([name, folder]) => {
      const below = path ? `${path}/${name}` : name;
      return {
        folder: below,
        parts: blocks(folder, order, below),
        size: folder.size,
      };
    }),
  ];
}

function blockSize(block: Block) {
  return "files" in block ? block.files.length : block.size;
}

/** `count` sites filling a seeded, irregular footprint at the given spacing. */
function sunflower(count: number, spacing: number, seed: string): Site[] {
  const step = spacing / spacingPerRadiusStep;
  const phase = unit(seed) * Math.PI * 2;
  return Array.from({ length: count }, (_, i) => {
    const angle = i * goldenAngle;
    // Broad, seeded lobes give the coast headlands and bays while retaining
    // the folder partition's sites and keeping the interior densely filled.
    const envelope =
      1 +
      0.22 * Math.sin(3 * angle + phase) +
      0.12 * Math.cos(5 * angle - phase);
    const radius = step * Math.sqrt(i + 0.5) * envelope;
    return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
  });
}

/**
 * Splits `sites` across their wider extent, the first `count` to the west
 * (or north), and parts the two by `gutter`.
 */
function split(
  sites: Site[],
  count: number,
  gutter: number
): [Site[], Site[], Pick<CellSplit, "at" | "axis">] {
  const xs = sites.map((site) => site.x);
  const ys = sites.map((site) => site.y);
  const across =
    Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys);
  const along = (site: Site) => (across ? site.x : site.y);
  const other = (site: Site) => (across ? site.y : site.x);
  const sorted = [...sites].sort(
    (a, b) => along(a) - along(b) || other(a) - other(b)
  );
  const first = sorted.slice(0, count);
  const second = sorted.slice(count);
  for (const site of first) {
    if (across) {
      site.x -= gutter / 2;
    } else {
      site.y -= gutter / 2;
    }
  }
  for (const site of second) {
    if (across) {
      site.x += gutter / 2;
    } else {
      site.y += gutter / 2;
    }
  }
  return [
    first,
    second,
    {
      at: (Math.max(...first.map(along)) + Math.min(...second.map(along))) / 2,
      axis: across ? "x" : "y",
    },
  ];
}

/** The index splitting `sizes` into two runs closest to equal, never empty. */
function balance(sizes: readonly number[]): number {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  let best = 1;
  let bestGap = Number.POSITIVE_INFINITY;
  let before = 0;
  for (let i = 1; i < sizes.length; i += 1) {
    before += sizes[i - 1] ?? 0;
    const gap = Math.abs(total - 2 * before);
    if (gap < bestGap) {
      best = i;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * Puts `files`, in order, on `sites` by halving both again and again, so
 * that any run of consecutive files takes a compact patch of the sites.
 */
function packFiles(files: readonly SpyglassFile[], sites: Site[]): void {
  const [only] = files;
  if (files.length === 1 && only) {
    const [site] = sites;
    only.x = site?.x ?? 0;
    only.y = site?.y ?? 0;
    return;
  }
  if (files.length === 0) {
    return;
  }
  const half = Math.floor(files.length / 2);
  const [first, second] = split(sites, half, 0);
  packFiles(files.slice(0, half), first);
  packFiles(files.slice(half), second);
}

/**
 * Splits the sites between the blocks of `cell`'s folder, recording each cut
 * in it and each subfolder's cell under it, and halving the gutter at every
 * split below: whatever moves inside one side afterwards moves less than
 * half the gutter in all, so no site crosses back over a cut.
 */
function divide(
  parts: readonly Block[],
  sites: Site[],
  gutter: number,
  cell: FolderCell,
  region: Rect
): void {
  const [only] = parts;
  if (parts.length === 1 && only) {
    if ("files" in only) {
      packFiles(only.files, sites);
      return;
    }
    const below: FolderCell = {
      folder: only.folder,
      folders: [],
      region,
      sites,
      splits: [],
    };
    cell.folders.push(below);
    divide(only.parts, sites, gutter, below, region);
    return;
  }
  const at = balance(parts.map(blockSize));
  const count = parts
    .slice(0, at)
    .reduce((sum, block) => sum + blockSize(block), 0);
  const [first, second, { at: where, axis }] = split(sites, count, gutter);
  const across = axis === "x";
  cell.splits.push({
    at: where,
    axis,
    from: across ? region.y0 : region.x0,
    to: across ? region.y1 : region.x1,
  });
  const before = across ? { ...region, x1: where } : { ...region, y1: where };
  const after = across ? { ...region, x0: where } : { ...region, y0: where };
  divide(parts.slice(0, at), first, gutter / 2, cell, before);
  divide(parts.slice(at), second, gutter / 2, cell, after);
}

/**
 * Files by district, one rank for the whole island: districts with more
 * files first, then by id, files without one last, then by path. A
 * district thus takes the same side of every folder it reaches, and one
 * compact patch in each.
 */
function byDistrict(
  files: readonly SpyglassFile[],
  districtOf: (file: SpyglassFile) => string | undefined
): FileOrder {
  const sizes = new Map<string, number>();
  for (const file of files) {
    const district = districtOf(file);
    if (district !== undefined) {
      sizes.set(district, (sizes.get(district) ?? 0) + 1);
    }
  }
  const rank = new Map(
    [...sizes]
      .sort((a, b) => b[1] - a[1] || byDistrictId(a, b))
      .map(([district], i) => [district, i])
  );
  const rankOf = (file: SpyglassFile) => {
    const district = districtOf(file);
    return district === undefined ? rank.size : (rank.get(district) ?? 0);
  };
  return (a, b) => rankOf(a) - rankOf(b) || byPath(a, b);
}

/**
 * Each file's district from the `responsibility-groups` lens: the group
 * whose member modules hold its path, the first by id where two do.
 */
export function districtsOfGroups(
  groups: readonly Pick<ResponsibilityGroup, "id" | "modules">[]
): (file: SpyglassFile) => string | undefined {
  const districts = new Map<string, string>();
  for (const group of [...groups].sort(byGroupId)) {
    for (const module of group.modules) {
      if (!districts.has(module)) {
        districts.set(module, group.id);
      }
    }
  }
  return (file) => districts.get(file.path);
}

/**
 * Places an island's files by the folder tree below the package's folder,
 * `root`: each folder a convex cell of a lattice sized to the island, its
 * own files by district (`districtOf`) where the island's districts are
 * known, else by path. Cells, and so the coast, do not depend on the
 * districts. Deterministic: the same paths and districts give the same
 * positions. Returns the cell tree, for drawing the folders.
 */
export function settleFiles(
  files: SpyglassFile[],
  radius: number,
  root: string,
  districtOf?: (file: SpyglassFile) => string | undefined
): FolderCell {
  const spacing = Math.min(
    widestSpacing,
    spacingPerSigma * contourSigma(radius, Math.max(1, files.length))
  );
  const sites = sunflower(files.length, spacing, root);
  // The island's box, wide enough for every gutter's push outward.
  const margin = topGutter * spacing;
  const xs = sites.map((site) => site.x);
  const ys = sites.map((site) => site.y);
  const region: Rect = files.length
    ? {
        x0: Math.min(...xs) - margin,
        x1: Math.max(...xs) + margin,
        y0: Math.min(...ys) - margin,
        y1: Math.max(...ys) + margin,
      }
    : { x0: 0, x1: 0, y0: 0, y1: 0 };
  const tree: FolderCell = {
    folder: "",
    folders: [],
    region,
    sites,
    splits: [],
  };
  if (files.length) {
    const order = districtOf ? byDistrict(files, districtOf) : byPath;
    divide(blocks(folderTree(files, root), order), sites, margin, tree, region);
  }
  return tree;
}

/** Folder navigation follows the actual restored file clusters without rearranging them. */
export function clusterFolders(
  files: SpyglassFile[],
  root: string
): FolderCell {
  const cell = (folder: string, members: SpyglassFile[]): FolderCell => ({
    folder,
    folders: [],
    region: members.length
      ? {
          x0: Math.min(...members.map((file) => file.x)),
          x1: Math.max(...members.map((file) => file.x)),
          y0: Math.min(...members.map((file) => file.y)),
          y1: Math.max(...members.map((file) => file.y)),
        }
      : { x0: 0, x1: 0, y0: 0, y1: 0 },
    sites: members.map(({ x, y }) => ({ x, y })),
    spatial: "cluster",
    splits: [],
  });
  const build = (folder: string, members: SpyglassFile[]): FolderCell => {
    const result = cell(folder, members);
    const children = new Map<string, SpyglassFile[]>();
    for (const file of members) {
      const within = folderWithin(file.directory, root);
      const rest = folder ? within.slice(folder.length + 1) : within;
      if (within === folder || !rest) {
        continue;
      }
      const [name] = rest.split("/");
      const path = folder ? `${folder}/${name}` : (name ?? "");
      const list = children.get(path) ?? [];
      list.push(file);
      children.set(path, list);
    }
    result.folders = [...children]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, list]) => build(path, list));
    return result;
  };
  return build("", files);
}
