/**
 * What the world planner (world-plan.ts) builds before it lays anything
 * out: each island's files sorted into what they are (TOWNS.md rule 4),
 * the folder tree that becomes its streets (rule 2), the test grounds
 * beside the streets they test (rule 5), and each street's households
 * gathered into buildings by how crowded it is (rule 3). Nothing here
 * knows about the land; the order of everything is the order things will
 * stand along their streets.
 */
import type { Import, Module } from "../../../data/chart";
import type { BuildingKind, RoadRank } from "./world";

/** Folder names that hold tests; their files are grounds, not streets. */
const TEST_FOLDERS: ReadonlySet<string> = new Set([
	"test",
	"tests",
	"__tests__",
]);
/** A source file imported by this many or more is a public building. */
const CIVIC_FAN_IN = 20;
/** How many lots a street of each rank holds before its households build up. */
const LOT_CAP: Readonly<Record<RoadRank, number>> = {
	main: 40,
	street: 24,
	lane: 14,
	path: 4,
};
/** A folder with more homes than this may build the island's one tower. */
const TOWER_FOLDER = 48;
const TOWER_STOREYS = 10;
const TOWER_FLATS = 6;
const BLOCK_MIN = 9;
const BLOCK_MAX = 24;
const WALKUP_MIN = 4;
const WALKUP_MAX = 8;
const PAIR_MAX = 3;
/** Lots' worth of frontage each kind of building takes. */
const SLOTS: Readonly<Partial<Record<BuildingKind, number>>> = {
	pair: 1,
	walkup: 2,
	block: 3,
	tower: 3,
};

export type Place = "home" | "utility" | "store" | "civic" | "station";

export const byText = (a: string, b: string): number => {
	if (a < b) {
		return -1;
	}
	return a > b ? 1 : 0;
};

export const folderOf = (id: string): string =>
	id.slice(0, Math.max(id.lastIndexOf("/"), 0));

const segmentsOf = (path: string): string[] =>
	path === "" ? [] : path.split("/");

/** Where a path's first test folder is among its segments, or -1. */
const testSegmentOf = (path: string): number =>
	segmentsOf(path).findIndex((segment) => TEST_FOLDERS.has(segment));

export const isTestLike = (module: Module): boolean =>
	module.kind === "test" || testSegmentOf(folderOf(module.id)) >= 0;

/** A file nothing imports and that imports nothing: it stands alone (rule 15). */
export const isAlone = (module: Module): boolean =>
	module.fanIn === 0 && module.fanOut === 0 && module.kind !== "config";

/** A street's rank from its folder's depth below the package root. */
export const rankOf = (depth: number): RoadRank => {
	if (depth <= 1) {
		return "main";
	}
	return depth === 2 ? "street" : "lane";
};

/** The kind of ground a test group makes, by its number of tests (rule 5). */
export type GroundKind = "playground" | "pitch" | "track" | "stadium";

export const groundKindOf = (tests: number): GroundKind => {
	if (tests <= 3) {
		return "playground";
	}
	if (tests <= 12) {
		return "pitch";
	}
	return tests <= 40 ? "track" : "stadium";
};

export interface Ground {
	readonly files: Module[];
	readonly key: string;
}

/** A building before it has a place: its kind, files and floors. */
export interface Household {
	readonly files: Module[];
	/** Flats a floor, which sets its length along the street. */
	readonly flats: number;
	readonly kind: BuildingKind;
	readonly storeys: number;
}

/** One thing that stands along a street, in order. */
export type Unit =
	| {
			readonly kind: "building";
			readonly name: string;
			readonly home: Household;
	  }
	| { readonly kind: "ground"; readonly name: string; readonly ground: Ground }
	| {
			readonly kind: "branch";
			readonly name: string;
			readonly node: FolderNode;
	  };

export interface FolderNode {
	readonly children: FolderNode[];
	readonly depth: number;
	/** Every file its street and its branches hold, grounds included. */
	files: Module[];
	readonly grounds: Ground[];
	/** Its own files that are homes, in id order. */
	readonly homes: Module[];
	readonly path: string;
	readonly rank: RoadRank;
	/** Its own files that are other places. */
	readonly specials: Module[];
	/** What stands along its street, in order; set by `orderStreets`. */
	units: Unit[];
}

/** One island's files, sorted into what they are. */
export interface Sorted {
	/** Files that stand alone, for the shore row and the lighthouse. */
	readonly alone: Module[];
	readonly nodes: ReadonlyMap<string, FolderNode>;
	readonly places: ReadonlyMap<string, Place>;
	/** The station's file, or null when the island has no source file. */
	readonly station: Module | null;
	readonly top: FolderNode;
}

/** What each of an island's town files is: its place in town (rule 4). */
function placesOf(files: readonly Module[]) {
	const places = new Map<string, Place>();
	let station: Module | null = null;
	for (const m of files) {
		if (m.kind !== "source") {
			continue;
		}
		if (
			!station ||
			m.fanIn > station.fanIn ||
			(m.fanIn === station.fanIn && byText(m.id, station.id) < 0)
		) {
			station = m;
		}
	}
	for (const m of files) {
		let place: Place = "home";
		if (m === station) {
			place = "station";
		} else if (m.kind === "config") {
			place = "utility";
		} else if (m.role === "aggregator") {
			place = "store";
		} else if (m.kind === "source" && m.fanIn >= CIVIC_FAN_IN) {
			place = "civic";
		}
		places.set(m.id, place);
	}
	return { places, station };
}

function commonFolder(paths: readonly string[]): string {
	const [first, ...rest] = paths.map(segmentsOf);
	let common = first ?? [];
	for (const segments of rest) {
		let n = 0;
		while (n < common.length && common[n] === segments[n]) {
			n += 1;
		}
		common = common.slice(0, n);
	}
	return common.join("/");
}

/** The package root: the deepest folder holding every street's files. */
function rootOf(streetFiles: readonly Module[], all: readonly Module[]) {
	let root = commonFolder(
		(streetFiles.length > 0 ? streetFiles : all).map((m) => folderOf(m.id))
	);
	for (;;) {
		const own = streetFiles.some((m) => folderOf(m.id) === root);
		const below = new Set<string>();
		for (const m of streetFiles) {
			const rest = segmentsOf(folderOf(m.id)).slice(segmentsOf(root).length);
			if (rest[0] !== undefined) {
				below.add(rest[0]);
			}
		}
		const [only] = below;
		if (own || below.size !== 1 || only === undefined) {
			return root;
		}
		root = root === "" ? only : `${root}/${only}`;
	}
}

function newNode(path: string, depth: number): FolderNode {
	return {
		path,
		depth,
		rank: rankOf(depth),
		homes: [],
		specials: [],
		children: [],
		grounds: [],
		files: [],
		units: [],
	};
}

/** The folder tree below `root`: a node for each folder a street's file is in. */
function treeOf(
	root: string,
	streetFiles: readonly Module[],
	places: ReadonlyMap<string, Place>
) {
	const top = newNode(root, 0);
	const nodes = new Map<string, FolderNode>([[root, top]]);
	const nodeOf = (path: string): FolderNode => {
		const known = nodes.get(path);
		if (known) {
			return known;
		}
		const up = folderOf(path);
		const parent = nodeOf(up === path || !path.startsWith(root) ? root : up);
		const node = newNode(path, parent.depth + 1);
		parent.children.push(node);
		nodes.set(path, node);
		return node;
	};
	for (const m of [...streetFiles].sort((a, b) => byText(a.id, b.id))) {
		const place = places.get(m.id) ?? "home";
		if (place === "station") {
			continue;
		}
		const folder = nodeOf(folderOf(m.id));
		(place === "home" ? folder.homes : folder.specials).push(m);
	}
	for (const node of nodes.values()) {
		node.children.sort((a, b) => byText(a.path, b.path));
	}
	return { top, nodes };
}

/** A test group's key: its folder, cut one level below its test folder. */
function groundKeyOf(module: Module): string {
	const folder = folderOf(module.id);
	const at = testSegmentOf(folder);
	return at < 0
		? folder
		: segmentsOf(folder)
				.slice(0, at + 2)
				.join("/");
}

/** The folder a tally names most, ties to the first by name. */
function mostOf(
	tally: ReadonlyMap<string, number> | undefined,
	nodes: ReadonlyMap<string, FolderNode>
): FolderNode | null {
	let best: [string, number] | null = null;
	for (const entry of tally ?? []) {
		if (
			nodes.has(entry[0]) &&
			(!best ||
				entry[1] > best[1] ||
				(entry[1] === best[1] && byText(entry[0], best[0]) < 0))
		) {
			best = entry;
		}
	}
	return best ? (nodes.get(best[0]) ?? null) : null;
}

/** A ground whose tests import nothing in town: the folder its name mirrors. */
function mirrorOf(
	key: string,
	nodes: ReadonlyMap<string, FolderNode>,
	top: FolderNode
): FolderNode {
	const segments = segmentsOf(key);
	const at = segments.findIndex((s) => TEST_FOLDERS.has(s));
	const rest = segments.slice(at + 1).join("/");
	if (at >= 0 && rest !== "") {
		const mirrors = [...nodes.values()]
			.filter((n) => n.path.endsWith(`/${rest}`) || n.path === rest)
			.sort((a, b) => a.depth - b.depth || byText(a.path, b.path));
		if (mirrors[0]) {
			return mirrors[0];
		}
	}
	let path = at >= 0 ? segments.slice(0, at).join("/") : key;
	while (path !== "" && !nodes.has(path)) {
		path = folderOf(path);
	}
	return nodes.get(path) ?? top;
}

/** The test files' grounds, each on the street of the folder its tests import most. */
function attachGrounds(
	tests: readonly Module[],
	nodes: ReadonlyMap<string, FolderNode>,
	top: FolderNode,
	imports: readonly Import[],
	streetFolder: ReadonlyMap<string, string>
) {
	const groups = new Map<string, Module[]>();
	for (const m of [...tests].sort((a, b) => byText(a.id, b.id))) {
		const key = groundKeyOf(m);
		const list = groups.get(key) ?? [];
		list.push(m);
		groups.set(key, list);
	}
	const groupOf = new Map<string, string>();
	for (const [key, files] of groups) {
		for (const m of files) {
			groupOf.set(m.id, key);
		}
	}
	const tallies = new Map<string, Map<string, number>>();
	for (const imp of imports) {
		const key = groupOf.get(imp.from);
		const folder = streetFolder.get(imp.to);
		if (key !== undefined && folder !== undefined) {
			const tally = tallies.get(key) ?? new Map<string, number>();
			tally.set(folder, (tally.get(folder) ?? 0) + 1);
			tallies.set(key, tally);
		}
	}
	for (const [key, files] of [...groups].sort((a, b) => byText(a[0], b[0]))) {
		const target = mostOf(tallies.get(key), nodes) ?? mirrorOf(key, nodes, top);
		target.grounds.push({ key, files });
	}
}

/**
 * A folder with nothing of its own and one folder below it is only a
 * junction on the way there: its child's street branches straight off
 * the parent's instead, so no stub of road is left at the corner.
 */
function collapse(node: FolderNode, nodes: Map<string, FolderNode>) {
	for (const [k, child] of node.children.entries()) {
		let only = child;
		while (
			only.homes.length === 0 &&
			only.specials.length === 0 &&
			only.grounds.length === 0 &&
			only.children.length === 1
		) {
			nodes.delete(only.path);
			only = only.children[0] as FolderNode;
		}
		node.children[k] = only;
		collapse(only, nodes);
	}
}

/** Each folder's files from its branches up. */
function gather(node: FolderNode): Module[] {
	const files = [...node.homes, ...node.specials];
	for (const ground of node.grounds) {
		files.push(...ground.files);
	}
	for (const child of node.children) {
		files.push(...gather(child));
	}
	node.files = files;
	return files;
}

/**
 * One island's files sorted into the shore, the station, the folder tree
 * and its grounds. The station's file stands at the plaza, not on its
 * folder's street.
 */
export function sortIsland(
	files: readonly Module[],
	imports: readonly Import[]
): Sorted {
	const alone = files.filter(isAlone).sort((a, b) => byText(a.id, b.id));
	const inTown = files.filter((m) => !isAlone(m));
	const tests = inTown.filter(isTestLike);
	const streetFiles = inTown.filter((m) => !isTestLike(m));
	const { places, station } = placesOf(streetFiles);
	const root = rootOf(streetFiles, inTown);
	const { top, nodes } = treeOf(root, streetFiles, places);
	const streetFolder = new Map(
		streetFiles.map((m) => [m.id, folderOf(m.id)] as const)
	);
	attachGrounds(tests, nodes, top, imports, streetFolder);
	collapse(top, nodes);
	gather(top);
	return { alone, nodes, places, station, top };
}

// --------------------------------------------------------- the households

const clamp = (x: number, lo: number, hi: number): number =>
	Math.max(lo, Math.min(hi, x));

/** A building of `files` homes of a kind, its floors and flats a floor. */
export function householdOf(kind: BuildingKind, files: Module[]): Household {
	const n = files.length;
	let storeys = 2;
	if (kind === "walkup") {
		storeys = n <= 5 ? 2 : 3;
	} else if (kind === "block") {
		storeys = clamp(Math.ceil(n / 5), 3, 5);
	} else if (kind === "tower") {
		storeys = Math.min(TOWER_STOREYS, Math.ceil(n / TOWER_FLATS));
	}
	return { kind, files, storeys, flats: Math.ceil(n / storeys) };
}

/** The sizes of the buildings a street's homes stack into, biggest first. */
function stackSizes(
	homes: number,
	cap: number,
	tower: boolean
): BuildingKind[] {
	const kinds: BuildingKind[] = [];
	let excess = homes - cap;
	let towerLeft = tower;
	const push = (kind: BuildingKind, files: number) => {
		kinds.push(...Array.from({ length: files }, () => kind));
		excess -= files - (SLOTS[kind] ?? 1);
	};
	while (excess > 0) {
		if (towerLeft) {
			towerLeft = false;
			push("tower", Math.min(TOWER_STOREYS * TOWER_FLATS, excess + 3));
		} else if (excess >= BLOCK_MIN - 3) {
			push("block", clamp(excess + 3, BLOCK_MIN, BLOCK_MAX));
		} else if (excess >= WALKUP_MIN - 2) {
			push("walkup", clamp(excess + 2, WALKUP_MIN, WALKUP_MAX));
		} else {
			push("pair", clamp(excess + 1, 2, PAIR_MAX));
		}
	}
	return kinds;
}

/**
 * A street's homes, in their order along it, gathered into buildings: as
 * many houses as the street has lots for, the rest stacked into as few
 * bigger buildings as hold them (rule 3), standing first in the street's
 * order, nearest its mouth and the town's middle.
 */
function householdsOf(
	homes: readonly Module[],
	cap: number,
	tower: boolean
): Household[] {
	const kinds = stackSizes(homes.length, cap, tower);
	const out: Household[] = [];
	let k = 0;
	while (k < homes.length) {
		const kind = kinds[k];
		if (kind === undefined) {
			out.push(householdOf("house", [homes[k] as Module]));
			k += 1;
			continue;
		}
		let end = k;
		while (
			end < homes.length &&
			kinds[end] === kind &&
			end - k < sizeCap(kind)
		) {
			end += 1;
		}
		out.push(householdOf(kind, homes.slice(k, end)));
		k = end;
	}
	return out;
}

const sizeCap = (kind: BuildingKind): number => {
	if (kind === "tower") {
		return TOWER_STOREYS * TOWER_FLATS;
	}
	if (kind === "block") {
		return BLOCK_MAX;
	}
	return kind === "walkup" ? WALKUP_MAX : PAIR_MAX;
};

// ---------------------------------------------------------- the ordering

/** The imports between each two items (both ways), and each item's in all. */
function affinityOf(
	groups: readonly (readonly Module[])[],
	imports: readonly Import[]
) {
	const n = groups.length;
	const groupOf = new Map<string, number>();
	for (const [index, files] of groups.entries()) {
		for (const m of files) {
			groupOf.set(m.id, index);
		}
	}
	const affinity = new Float64Array(n * n);
	const total = new Float64Array(n);
	for (const imp of imports) {
		const a = groupOf.get(imp.from);
		const b = groupOf.get(imp.to);
		if (a !== undefined && b !== undefined && a !== b) {
			affinity[a * n + b] = (affinity[a * n + b] ?? 0) + 1;
			affinity[b * n + a] = (affinity[b * n + a] ?? 0) + 1;
			total[a] = (total[a] ?? 0) + 1;
			total[b] = (total[b] ?? 0) + 1;
		}
	}
	return { affinity, total };
}

const isBetter = (a: readonly number[], b: readonly number[]): boolean => {
	for (const [k, value] of a.entries()) {
		const other = b[k] ?? 0;
		if (value !== other) {
			return value > other;
		}
	}
	return false;
};

/**
 * Items in chain order: the first `fixed` stay first, then each next is
 * the one most imported to or from the last, ties to everything placed so
 * far, then to the most connected, then the given order.
 */
export function chainOf<T>(
	items: readonly T[],
	filesOf: (item: T) => readonly Module[],
	fixed: number,
	imports: readonly Import[]
): T[] {
	const n = items.length;
	const { affinity, total } = affinityOf(items.map(filesOf), imports);
	const placed = new Uint8Array(n);
	const toPlaced = new Float64Array(n);
	const order: number[] = [];
	const put = (index: number) => {
		placed[index] = 1;
		order.push(index);
		for (let x = 0; x < n; x += 1) {
			toPlaced[x] = (toPlaced[x] ?? 0) + (affinity[index * n + x] ?? 0);
		}
	};
	for (let index = 0; index < Math.min(fixed, n); index += 1) {
		put(index);
	}
	while (order.length < n) {
		const last = order.at(-1);
		const scoreOf = (x: number): readonly number[] => [
			last === undefined ? 0 : (affinity[last * n + x] ?? 0),
			toPlaced[x] ?? 0,
			total[x] ?? 0,
		];
		let best = -1;
		for (let x = 0; x < n; x += 1) {
			if (!placed[x] && (best < 0 || isBetter(scoreOf(x), scoreOf(best)))) {
				best = x;
			}
		}
		put(best);
	}
	return order.map((index) => items[index] as T);
}

type Item =
	| { readonly kind: "home"; readonly name: string; readonly file: Module }
	| { readonly kind: "special"; readonly name: string; readonly file: Module }
	| { readonly kind: "ground"; readonly name: string; readonly ground: Ground }
	| {
			readonly kind: "branch";
			readonly name: string;
			readonly node: FolderNode;
	  };

function itemFiles(item: Item): readonly Module[] {
	if (item.kind === "home" || item.kind === "special") {
		return [item.file];
	}
	return item.kind === "ground" ? item.ground.files : item.node.files;
}

const SPECIAL_KIND: Readonly<Record<Exclude<Place, "home">, BuildingKind>> = {
	utility: "utility",
	store: "store",
	civic: "civic",
	station: "station",
};

/** One street's units in order, its homes gathered into buildings. */
function unitsOf(
	node: FolderNode,
	sorted: Sorted,
	imports: readonly Import[],
	share: number,
	towerFolder: string | null
): Unit[] {
	const placeOf = (m: Module): Place => sorted.places.get(m.id) ?? "home";
	const stores = node.specials.filter((m) => placeOf(m) === "store");
	const rest: Item[] = [
		...node.specials
			.filter((m) => placeOf(m) !== "store")
			.map((file): Item => ({ kind: "special", name: file.id, file })),
		...node.homes.map((file): Item => ({ kind: "home", name: file.id, file })),
		...node.grounds.map(
			(ground): Item => ({ kind: "ground", name: ground.key, ground })
		),
		...node.children.map(
			(child): Item => ({ kind: "branch", name: child.path, node: child })
		),
	].sort((a, b) => byText(a.name, b.name));
	const items = chainOf<Item>(
		[
			...stores.map((file): Item => ({ kind: "special", name: file.id, file })),
			...rest,
		],
		itemFiles,
		stores.length,
		imports
	);
	const homes = items.flatMap((item) =>
		item.kind === "home" ? [item.file] : []
	);
	const cap = Math.max(4, Math.round(LOT_CAP[node.rank] * share));
	const households = householdsOf(homes, cap, node.path === towerFolder);
	const units: Unit[] = [];
	let next = 0;
	const homeUnits = households.map((home) => ({
		kind: "building" as const,
		name: home.files[0]?.id ?? "",
		home,
	}));
	for (const item of items) {
		if (item.kind === "home") {
			// Each home's place in the chain goes to the next household in turn.
			const unit = homeUnits[next];
			if (unit && unit.home.files[0] === item.file) {
				units.push(unit);
				next += 1;
			}
			continue;
		}
		if (item.kind === "special") {
			const kind = SPECIAL_KIND[placeOf(item.file) as Exclude<Place, "home">];
			units.push({
				kind: "building",
				name: item.name,
				home: householdOf(kind, [item.file]),
			});
		} else if (item.kind === "ground") {
			units.push({ kind: "ground", name: item.name, ground: item.ground });
		} else {
			units.push({ kind: "branch", name: item.name, node: item.node });
		}
	}
	return units;
}

/**
 * Orders every street's units. `share` scales how many lots a street
 * holds (below 1 on a crowded island). The island's one tower goes to its
 * most crowded folder, if that folder holds more homes than blocks
 * nearby could take.
 */
export function orderStreets(
	sorted: Sorted,
	imports: readonly Import[],
	share: number
) {
	let towerFolder: string | null = null;
	let most = TOWER_FOLDER;
	for (const node of sorted.nodes.values()) {
		if (
			node.homes.length > most ||
			(node.homes.length === most &&
				towerFolder !== null &&
				byText(node.path, towerFolder) < 0)
		) {
			most = node.homes.length;
			towerFolder = node.path;
		}
	}
	for (const node of sorted.nodes.values()) {
		node.units = unitsOf(node, sorted, imports, share, towerFolder);
	}
}
