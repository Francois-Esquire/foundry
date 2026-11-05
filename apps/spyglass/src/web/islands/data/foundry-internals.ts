/**
 * The islands' insides from a Spyglass dataset: its modules, the imports
 * between them, and its responsibility groups as districts. Read by
 * narrowing like the rest of foundry.ts: whatever does not fit is left out,
 * one line in `source.notes` per reason.
 *
 * The files keep the dataset's own shapes, so a full dataset reads the same
 * as the fixture's trimmed copy (`capture.ts` in `foundry/`):
 *
 * - `modules`: `modules/index.json`, every module with its package, its
 *   place on its island (`mapPosition`), kind, role and fan-in and fan-out;
 * - `shards`: the module shards, `modules/<package>.json`, read for each
 *   module's `evolution`;
 * - `edges`: the edge shards, `modules/edges/<package>.json`;
 * - `responsibilityGroups` and `frequentChange`: those lenses,
 *   `lenses/<id>.json`.
 */
import type {
	Change,
	District,
	Import,
	Island,
	Module,
	ModuleKind,
	Point,
} from "./chart";
import {
	type Fields,
	isFields,
	isNonNegative,
	isText,
	listOf,
	type Notes,
	readPlace,
} from "./foundry-read";
import { polygonContains } from "./geometry";

/** What `chartFromFoundry` adds to a chart from the internals. */
export interface Internals {
	readonly districts: District[];
	readonly imports: Import[];
	readonly modules: Module[];
}

const MODULE_KINDS: ReadonlySet<string> = new Set<ModuleKind>([
	"config",
	"other",
	"source",
	"story",
	"test",
	"unknown",
]);

const isModuleKind = (value: unknown): value is ModuleKind =>
	typeof value === "string" && MODULE_KINDS.has(value);

/** Every `key` list of a list of records, end to end: a lens's or shards' entries. */
const entriesOf = (records: unknown, key: string): readonly unknown[] =>
	listOf(records).flatMap((record) =>
		listOf(isFields(record) ? record[key] : undefined)
	);

/** A module as the index lists it, before its districts are known. */
type Placed = Omit<Module, "change" | "districts">;

function readModule(
	value: unknown,
	islands: ReadonlyMap<string, Island>,
	notes: Notes
): Placed | null {
	if (!(isFields(value) && isText(value.id))) {
		notes.add("modules: a module without an id skipped");
		return null;
	}
	const island = isText(value.package) ? islands.get(value.package) : undefined;
	if (!island) {
		notes.add("modules: a module of a package not on the chart skipped");
		return null;
	}
	const place = isFields(value.mapPosition)
		? readPlace(value.mapPosition)
		: null;
	if (!place) {
		notes.add("modules: a module without a place on its island skipped");
		return null;
	}
	const { fileKind, role } = value;
	let kind: ModuleKind = "unknown";
	if (isModuleKind(fileKind)) {
		kind = fileKind;
	} else {
		notes.add("modules: a module of no known kind read as unknown");
	}
	const count = (field: unknown): number => {
		if (isNonNegative(field)) {
			return field;
		}
		notes.add("modules: a missing fan-in or fan-out read as 0");
		return 0;
	};
	const at: Point = [island.at[0] + place[0], island.at[1] + place[1]];
	// The coasts are contoured round the files, so a file off its coast
	// means the map and the module index come from different scans.
	const { coast } = island.shape;
	if (
		coast.length > 0 &&
		!coast.some((polygon) => polygonContains(polygon, at))
	) {
		notes.add(
			"modules: a module off its island's coast, the map and modules from different scans?"
		);
	}
	return {
		at,
		fanIn: count(value.fanIn),
		fanOut: count(value.fanOut),
		id: value.id,
		island: island.id,
		kind,
		role: role === "aggregator" || role === "internal" ? role : null,
	};
}

function readModules(
	index: Fields,
	islands: ReadonlyMap<string, Island>,
	notes: Notes
): Placed[] {
	const modules: Placed[] = [];
	const seen = new Set<string>();
	for (const value of listOf(index.modules)) {
		const module = readModule(value, islands, notes);
		if (module && seen.has(module.id)) {
			notes.add("modules: a repeated module skipped");
		} else if (module) {
			seen.add(module.id);
			modules.push(module);
		}
	}
	return modules;
}

/** The frequent-change lens's files among the modules. */
function readFrequent(
	lens: unknown,
	modules: ReadonlySet<string>,
	notes: Notes
): ReadonlySet<string> {
	const frequent = new Set<string>();
	const packages = isFields(lens) ? lens.packages : undefined;
	for (const file of entriesOf(packages, "files")) {
		if (isFields(file) && isText(file.file) && modules.has(file.file)) {
			frequent.add(file.file);
		} else {
			notes.add("frequent change: a file not among the modules skipped");
		}
	}
	return frequent;
}

/** A module shard's history for one module, or null when unreadable. */
function readChange(evolution: unknown, frequent: boolean): Change | null {
	if (
		!(
			isFields(evolution) &&
			isNonNegative(evolution.authors) &&
			isNonNegative(evolution.commits) &&
			isNonNegative(evolution.linesChanged)
		)
	) {
		return null;
	}
	const { authors, commits, linesChanged } = evolution;
	return { authors, commits, frequent, linesChanged };
}

/** Each module's history from the shards, by id; frequent ones from the lens. */
function readChanges(
	shards: unknown,
	frequentChange: unknown,
	modules: ReadonlySet<string>,
	notes: Notes
): ReadonlyMap<string, Change> {
	const frequent = readFrequent(frequentChange, modules, notes);
	const changes = new Map<string, Change>();
	for (const value of entriesOf(shards, "modules")) {
		if (!(isFields(value) && isText(value.id) && modules.has(value.id))) {
			continue;
		}
		const change = readChange(value.evolution, frequent.has(value.id));
		if (change) {
			changes.set(value.id, change);
		} else {
			notes.add("module shards: a module without a readable history");
		}
	}
	return changes;
}

function readDistrict(
	value: unknown,
	island: string,
	modules: ReadonlyMap<string, Placed>,
	notes: Notes
): District | null {
	if (!(isFields(value) && isText(value.id))) {
		notes.add("responsibility groups: a group without an id skipped");
		return null;
	}
	const members: string[] = [];
	for (const id of listOf(value.modules)) {
		if (isText(id) && modules.get(id)?.island === island) {
			members.push(id);
		} else {
			notes.add(
				"responsibility groups: a member not among its island's modules dropped"
			);
		}
	}
	const [first] = members;
	if (first === undefined) {
		notes.add("responsibility groups: a group with no modules skipped");
		return null;
	}
	const { anchorModule, label: named } = value;
	let anchor = first;
	if (isText(anchorModule) && members.includes(anchorModule)) {
		anchor = anchorModule;
	} else {
		notes.add(
			"responsibility groups: a group without its anchor module anchored at its first member"
		);
	}
	let label = anchor;
	if (isText(named)) {
		label = named;
	} else {
		notes.add(
			"responsibility groups: a group without a label named by its anchor"
		);
	}
	return {
		anchor,
		id: value.id,
		island,
		label,
		modules: [...new Set(members)],
	};
}

function readDistricts(
	lens: unknown,
	islands: ReadonlyMap<string, Island>,
	modules: ReadonlyMap<string, Placed>,
	notes: Notes
): District[] {
	const districts: District[] = [];
	const seen = new Set<string>();
	for (const pkg of listOf(isFields(lens) ? lens.packages : undefined)) {
		if (!(isFields(pkg) && isText(pkg.id) && islands.has(pkg.id))) {
			notes.add("responsibility groups: a package not on the chart skipped");
			continue;
		}
		for (const value of listOf(pkg.groups)) {
			const district = readDistrict(value, pkg.id, modules, notes);
			if (district && seen.has(district.id)) {
				notes.add("responsibility groups: a repeated group skipped");
			} else if (district) {
				seen.add(district.id);
				districts.push(district);
			}
		}
	}
	return districts;
}

/** One edge as an import, or null with a note when it joins no two modules. */
function readImport(
	value: unknown,
	modules: ReadonlyMap<string, Placed>,
	notes: Notes
): Import | null {
	if (!isFields(value)) {
		notes.add("module edges: an unreadable import skipped");
		return null;
	}
	const from = isText(value.source) ? modules.get(value.source) : undefined;
	const to = isText(value.target) ? modules.get(value.target) : undefined;
	if (!(from && to)) {
		notes.add(
			"module edges: an import between modules not on the chart skipped"
		);
		return null;
	}
	if (from.id === to.id) {
		notes.add("module edges: a module importing itself skipped");
		return null;
	}
	return {
		crossing: from.island !== to.island,
		from: from.id,
		to: to.id,
		typeOnly: value.typeOnly === true,
	};
}

function readImports(
	shards: unknown,
	modules: ReadonlyMap<string, Placed>,
	notes: Notes
): Import[] {
	const imports = new Map<string, Import>();
	for (const value of entriesOf(shards, "edges")) {
		const read = readImport(value, modules, notes);
		if (!read) {
			continue;
		}
		const key = `${read.from}\n${read.to}`;
		const known = imports.get(key);
		if (known) {
			// One import of the pair that runs makes the pair run.
			imports.set(key, { ...known, typeOnly: known.typeOnly && read.typeOnly });
			notes.add("module edges: a repeated import merged");
		} else {
			imports.set(key, read);
		}
	}
	return [...imports.values()];
}

/**
 * The internals for the chart's `islands`, or empty lists with a note when
 * there are none.
 */
export function readInternals(
	internals: unknown,
	islands: readonly Island[],
	notes: Notes
): Internals {
	if (internals === undefined) {
		notes.add("no internals: islands carry no modules, imports or districts");
		return { districts: [], imports: [], modules: [] };
	}
	if (!(isFields(internals) && isFields(internals.modules))) {
		notes.add("internals without a module index, ignored");
		return { districts: [], imports: [], modules: [] };
	}
	const byId = new Map(islands.map((island) => [island.id, island]));
	const placed = readModules(internals.modules, byId, notes);
	const placedById = new Map(placed.map((module) => [module.id, module]));
	const changes = readChanges(
		internals.shards,
		internals.frequentChange,
		new Set(placedById.keys()),
		notes
	);
	const districts = readDistricts(
		internals.responsibilityGroups,
		byId,
		placedById,
		notes
	);
	const districtsOf = new Map<string, string[]>();
	for (const district of districts) {
		for (const module of district.modules) {
			const list = districtsOf.get(module) ?? [];
			list.push(district.id);
			districtsOf.set(module, list);
		}
	}
	const modules = placed.map(
		(module): Module => ({
			...module,
			change: changes.get(module.id) ?? null,
			districts: districtsOf.get(module.id) ?? null,
		})
	);
	return {
		districts,
		imports: readImports(internals.edges, placedById, notes),
		modules,
	};
}
