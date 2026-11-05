/**
 * Foundry's prepared visualization (`map.json`, schema 1), its package
 * dependency graph (`dependency-graph.json`) and, when given, the islands'
 * insides from the same Spyglass dataset (foundry-internals.ts) as a
 * `Chart`.
 *
 * All arrive as `unknown` and are read by narrowing: whatever does not fit
 * is cleaned or left out, one line in `source.notes` per reason, and only an
 * unsupported `schemaVersion` throws. Foundry's coordinates already have
 * their origin at the centre of `width` by `height`, so they are kept as
 * they are, made absolute by adding each island's place to its rings.
 */
import {
	CHART_VERSION,
	type Chart,
	type Extent,
	type Foundation,
	type Group,
	type Island,
	type Lobe,
	type Member,
	type Point,
	type Polygon,
	type Ring,
	type Route,
	type Shape,
	type Supplier,
} from "./chart";
import { readInternals } from "./foundry-internals";
import {
	createNotes,
	type Fields,
	isFields,
	isFiniteNumber,
	isNonNegative,
	isText,
	listOf,
	type Notes,
	readPlace,
	readPoint,
} from "./foundry-read";
import { type Bounds, chartBounds, cleanRing, orientPolygon } from "./geometry";

/** A Foundry map this adapter cannot read. */
export class ChartError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ChartError";
	}
}

/** The `schemaVersion` this adapter reads. */
export const FOUNDRY_SCHEMA_VERSION = 1;
/** The geometry policy the adapter was written against; others are read the same, with a note. */
export const FOUNDRY_POLICY_VERSION = 6;

const DEFAULT_ROUTE_KIND = "dependency";
const DEFAULT_ROUTE_STRENGTH = 1;

/** A ring from Foundry's points about `at`, absolute, or null if unusable. */
function readRing(
	value: unknown,
	at: Point,
	where: string,
	notes: Notes
): Ring | null {
	const raw = listOf(value);
	const points: Point[] = [];
	for (const item of raw) {
		const p = readPoint(item);
		if (p) {
			points.push([at[0] + p[0], at[1] + p[1]]);
		}
	}
	if (points.length < raw.length) {
		const count = raw.length - points.length;
		notes.add(
			`${where}: ${count} unreadable ${count === 1 ? "point" : "points"} dropped`
		);
	}
	return cleanRing(points);
}

/** A Foundry polygon (outer ring, then holes) as a chart polygon, oriented. */
function readPolygon(
	value: unknown,
	at: Point,
	where: string,
	notes: Notes
): Polygon | null {
	const [outerValue, ...holeValues] = listOf(value);
	const outer = readRing(outerValue, at, where, notes);
	if (!outer) {
		notes.add(`${where}: a piece with no usable outer ring dropped`);
		return null;
	}
	const holes: Ring[] = [];
	for (const holeValue of holeValues) {
		const hole = readRing(holeValue, at, where, notes);
		if (hole) {
			holes.push(hole);
		} else {
			notes.add(`${where}: an unusable hole dropped`);
		}
	}
	return orientPolygon({ holes, outer });
}

function readLayer(
	value: unknown,
	at: Point,
	where: string,
	notes: Notes
): Polygon[] {
	const polygons: Polygon[] = [];
	for (const item of listOf(value)) {
		const polygon = readPolygon(item, at, where, notes);
		if (polygon) {
			polygons.push(polygon);
		}
	}
	return polygons;
}

/** What the graph says about one package. */
interface NodeFacts {
	readonly label: string | null;
	readonly layer: number | null;
}

/** The graph's nodes by id; edges are read with the routes. */
function readNodes(graph: Fields | null): ReadonlyMap<string, NodeFacts> {
	const nodes = new Map<string, NodeFacts>();
	for (const item of listOf(graph?.nodes)) {
		if (isFields(item) && isText(item.id) && !nodes.has(item.id)) {
			nodes.set(item.id, {
				label: isText(item.label) ? item.label : null,
				layer: isNonNegative(item.layer) ? item.layer : null,
			});
		}
	}
	return nodes;
}

/** The farthest coast point from the island's place: its size when the source gives none. */
function reach(at: Point, coast: readonly Polygon[]): number {
	let far = 0;
	for (const { outer } of coast) {
		for (const [x, y] of outer) {
			far = Math.max(far, Math.hypot(x - at[0], y - at[1]));
		}
	}
	return far;
}

function readIsland(
	value: unknown,
	index: number,
	nodes: ReadonlyMap<string, NodeFacts>,
	notes: Notes
): Island | null {
	if (!(isFields(value) && isText(value.id))) {
		notes.add(`islands[${index}]: no id, skipped`);
		return null;
	}
	const { id } = value;
	const at = readPlace(value);
	if (!at) {
		notes.add(`island ${id}: no place (x, y), skipped`);
		return null;
	}
	const shape: Shape = {
		coast: readLayer(value.coast, at, `island ${id} coast`, notes),
		hills: readLayer(value.hills, at, `island ${id} hills`, notes),
		shallows: readLayer(value.shallows, at, `island ${id} shallows`, notes),
	};
	if (shape.coast.length === 0) {
		notes.add(`island ${id}: no usable coast ring, skipped`);
		return null;
	}
	const node = nodes.get(id);
	let size = reach(at, shape.coast);
	if (isNonNegative(value.radius)) {
		size = value.radius;
	} else {
		notes.add(`island ${id}: no radius, sized by its coast`);
	}
	let name = id;
	if (node?.label) {
		name = node.label;
	} else if (isText(value.label)) {
		name = value.label;
	}
	return { at, id, layer: node?.layer ?? null, name, shape, size };
}

function readIslands(
	map: Fields,
	nodes: ReadonlyMap<string, NodeFacts>,
	notes: Notes
): Island[] {
	const islands: Island[] = [];
	const seen = new Set<string>();
	for (const [index, value] of listOf(map.islands).entries()) {
		const island = readIsland(value, index, nodes, notes);
		if (island && seen.has(island.id)) {
			notes.add(`island ${island.id}: repeated, later copies skipped`);
		} else if (island) {
			seen.add(island.id);
			islands.push(island);
		}
	}
	for (const id of nodes.keys()) {
		if (!seen.has(id)) {
			notes.add(`graph node ${id}: no island on the map, ignored`);
		}
	}
	return islands;
}

/** Where a route's strength is, by where the route came from. */
type StrengthOf = (route: Fields) => unknown;

const edgeStrength: StrengthOf = (edge) =>
	isFields(edge.dependency) ? edge.dependency.moduleEdges : undefined;

const routeStrength: StrengthOf = (route) => route.weight;

/** A route's ends, kind and strength, or null without both ends. */
function readRoute(value: unknown, strengthOf: StrengthOf): Route | null {
	if (!(isFields(value) && isText(value.from) && isText(value.to))) {
		return null;
	}
	const strength = strengthOf(value);
	return {
		from: value.from,
		kind: isText(value.kind) ? value.kind : DEFAULT_ROUTE_KIND,
		strength:
			isFiniteNumber(strength) && strength >= DEFAULT_ROUTE_STRENGTH
				? strength
				: DEFAULT_ROUTE_STRENGTH,
		to: value.to,
	};
}

/** Every list's routes between islands on the chart, each `from`, `to`, `kind` once. */
function readRoutes(
	lists: readonly (readonly [string, readonly unknown[], StrengthOf])[],
	islands: ReadonlySet<string>,
	notes: Notes
): Route[] {
	const routes: Route[] = [];
	const seen = new Set<string>();
	for (const [where, list, strengthOf] of lists) {
		for (const value of list) {
			const route = readRoute(value, strengthOf);
			const key = route && JSON.stringify([route.from, route.to, route.kind]);
			if (!(route && key)) {
				notes.add(`${where}: a route without both ends skipped`);
			} else if (!(islands.has(route.from) && islands.has(route.to))) {
				notes.add(
					`${where}: route ${route.from} → ${route.to} has an end off the chart, skipped`
				);
			} else if (route.from === route.to) {
				notes.add(`${where}: route ${route.from} → itself skipped`);
			} else if (seen.has(key)) {
				notes.add(
					`${where}: route ${route.from} → ${route.to} repeated, merged`
				);
			} else {
				seen.add(key);
				routes.push(route);
			}
		}
	}
	return routes;
}

/** Members on the chart, once each; `exclude` is never its own member. */
function readMembers(
	value: unknown,
	where: string,
	islands: ReadonlySet<string>,
	notes: Notes,
	exclude?: string
): Member[] {
	const members: Member[] = [];
	const seen = new Set<string>();
	for (const item of listOf(value)) {
		if (!(isFields(item) && isText(item.territoryId))) {
			notes.add(`${where}: a member without an island skipped`);
			continue;
		}
		const island = item.territoryId;
		const { distance, weight } = item;
		if (!islands.has(island)) {
			notes.add(`${where}: member ${island} is not on the chart, skipped`);
		} else if (island === exclude) {
			notes.add(`${where}: ${island} listed as its own member, skipped`);
		} else if (seen.has(island)) {
			notes.add(`${where}: member ${island} repeated, merged`);
		} else if (
			isFiniteNumber(distance) &&
			distance >= 1 &&
			isNonNegative(weight)
		) {
			seen.add(island);
			const direct =
				typeof item.direct === "boolean" ? item.direct : distance === 1;
			members.push({ direct, distance, island, weight });
		} else {
			notes.add(
				`${where}: member ${island} without distance or weight, skipped`
			);
		}
	}
	return members;
}

function readLobe(value: unknown, islands: ReadonlySet<string>): Lobe | null {
	if (!(isFields(value) && isText(value.territoryId))) {
		return null;
	}
	const { radius, territoryId, weight } = value;
	const at = readPlace(value);
	const usable =
		at &&
		islands.has(territoryId) &&
		isNonNegative(radius) &&
		isNonNegative(weight);
	return usable ? { at, island: territoryId, radius, weight } : null;
}

function readLobes(
	value: unknown,
	where: string,
	islands: ReadonlySet<string>,
	notes: Notes
): Lobe[] {
	const lobes: Lobe[] = [];
	for (const item of listOf(value)) {
		const lobe = readLobe(item, islands);
		if (lobe) {
			lobes.push(lobe);
		} else {
			notes.add(`${where}: a lobe off the chart or without a place skipped`);
		}
	}
	return lobes;
}

/** The centre of the lobes, for a foundation that gives no place of its own. */
function lobeCentre(lobes: readonly Lobe[]): Point | null {
	if (lobes.length === 0) {
		return null;
	}
	let x = 0;
	let y = 0;
	for (const lobe of lobes) {
		x += lobe.at[0];
		y += lobe.at[1];
	}
	return [x / lobes.length, y / lobes.length];
}

/** How much the workspace leans on it: the source's figure, or its member count. */
function readProminence(
	value: unknown,
	members: readonly Member[],
	where: string,
	notes: Notes
): number {
	if (isNonNegative(value)) {
		return value;
	}
	notes.add(`${where}: no prominence, counted from its members`);
	return members.length;
}

function readFoundation(
	value: unknown,
	index: number,
	islands: ReadonlySet<string>,
	notes: Notes
): Foundation | null {
	if (!(isFields(value) && isText(value.id))) {
		notes.add(`foundations[${index}]: no id, skipped`);
		return null;
	}
	const { id } = value;
	const where = `foundation ${id}`;
	const members = readMembers(value.members, where, islands, notes);
	if (members.length === 0) {
		notes.add(`${where}: no members on the chart, skipped`);
		return null;
	}
	const lobes = readLobes(value.lobes, where, islands, notes);
	const given = readPlace(value);
	const at = given ?? lobeCentre(lobes);
	if (!at) {
		notes.add(`${where}: no place and no lobes, skipped`);
		return null;
	}
	if (!given) {
		notes.add(`${where}: no place, placed at its lobes' centre`);
	}
	return {
		at,
		id,
		lobes,
		members,
		name: isText(value.name) ? value.name : id,
		prominence: readProminence(value.prominence, members, where, notes),
		versions: listOf(value.versions).filter(isText),
	};
}

/** Keeps the first of each id, noting the rest. */
function uniqueById<T extends { readonly id: string }>(
	items: readonly (T | null)[],
	what: string,
	notes: Notes
): T[] {
	const seen = new Set<string>();
	const kept: T[] = [];
	for (const item of items) {
		if (item && seen.has(item.id)) {
			notes.add(`${what} ${item.id}: repeated, later copies skipped`);
		} else if (item) {
			seen.add(item.id);
			kept.push(item);
		}
	}
	return kept;
}

/** The ids of `value` that `known` holds, once each; the rest noted. */
function knownIds(
	value: unknown,
	known: ReadonlySet<string>,
	where: string,
	notes: Notes
): string[] {
	const ids = new Set<string>();
	for (const item of listOf(value)) {
		if (isText(item) && known.has(item)) {
			ids.add(item);
		} else {
			notes.add(
				`${where}: ${isText(item) ? item : "an entry"} is not on the chart, dropped`
			);
		}
	}
	return [...ids];
}

function readGroup(
	value: unknown,
	index: number,
	islands: ReadonlySet<string>,
	foundations: ReadonlySet<string>,
	notes: Notes
): Group | null {
	if (!(isFields(value) && isText(value.id))) {
		notes.add(`groups[${index}]: no id, skipped`);
		return null;
	}
	const where = `group ${value.id}`;
	const group: Group = {
		foundations: knownIds(value.dependencyIds, foundations, where, notes),
		id: value.id,
		islands: knownIds(value.memberIds, islands, where, notes),
	};
	if (group.foundations.length === 0 || group.islands.length < 2) {
		notes.add(
			`${where}: fewer than two islands or no foundation left, skipped`
		);
		return null;
	}
	return group;
}

function readSupplier(
	value: unknown,
	index: number,
	islands: ReadonlySet<string>,
	notes: Notes
): Supplier | null {
	if (!(isFields(value) && isText(value.id))) {
		notes.add(`internalFoundations[${index}]: no id, skipped`);
		return null;
	}
	const { id, supplierId } = value;
	const where = `supplier ${id}`;
	if (!(isText(supplierId) && islands.has(supplierId))) {
		notes.add(`${where}: its supplying island is not on the chart, skipped`);
		return null;
	}
	const members = readMembers(value.members, where, islands, notes, supplierId);
	if (members.length === 0) {
		notes.add(`${where}: no members on the chart, skipped`);
		return null;
	}
	return {
		id,
		island: supplierId,
		members,
		prominence: readProminence(value.prominence, members, where, notes),
	};
}

/**
 * The extent from the source, grown to hold every coast if it does not; or,
 * without one, the smallest centred extent that does.
 */
function readExtent(
	map: Fields,
	land: Bounds,
	hasLand: boolean,
	notes: Notes
): Extent {
	const width = isFiniteNumber(map.width) && map.width > 0 ? map.width : 0;
	const height = isFiniteNumber(map.height) && map.height > 0 ? map.height : 0;
	const given = width > 0 && height > 0;
	const needWidth = hasLand
		? 2 * Math.max(Math.abs(land.minX), Math.abs(land.maxX))
		: 0;
	const needHeight = hasLand
		? 2 * Math.max(Math.abs(land.minY), Math.abs(land.maxY))
		: 0;
	if (!given) {
		notes.add("map: no width and height, sized to hold the coasts");
	} else if (needWidth > width || needHeight > height) {
		notes.add(
			"map: coasts reach past width and height, extent grown to hold them"
		);
	}
	const extent = {
		height: Math.max(height, needHeight),
		width: Math.max(width, needWidth),
	};
	if (extent.width > 0 && extent.height > 0) {
		return extent;
	}
	notes.add("map: nothing to size the chart by, extent set to 1 by 1");
	return { height: 1, width: 1 };
}

function noteUncarried(map: Fields, notes: Notes) {
	for (const key of ["ownDependencies", "formerPackages"] as const) {
		const count = listOf(map[key]).length;
		if (count > 0) {
			const entries = count === 1 ? "entry" : "entries";
			notes.add(`${key}: ${count} ${entries} not carried, no counterpart yet`);
		}
	}
	if (map.policyVersion !== FOUNDRY_POLICY_VERSION) {
		notes.add(
			`policyVersion ${String(map.policyVersion)}: written against ${FOUNDRY_POLICY_VERSION}, read the same`
		);
	}
}

/**
 * Foundry's `map.json` and, optionally, its dependency graph as a chart.
 * Throws `ChartError` only when `map` is not schema 1; everything else that
 * does not fit is cleaned or skipped with a note.
 */
export function chartFromFoundry(
	map: unknown,
	graph?: unknown,
	internals?: unknown
): Chart {
	if (!(isFields(map) && map.schemaVersion === FOUNDRY_SCHEMA_VERSION)) {
		const found = isFields(map) ? String(map.schemaVersion) : "none";
		throw new ChartError(
			`Foundry map schemaVersion ${found} is not supported; this reads ${FOUNDRY_SCHEMA_VERSION}`
		);
	}
	const notes = createNotes();
	let graphFields: Fields | null = null;
	if (isFields(graph)) {
		graphFields = graph;
	} else if (graph === undefined) {
		notes.add(
			"no dependency graph: islands named by id, no layers, routes only from the map"
		);
	} else {
		notes.add("dependency graph is not an object, ignored");
	}

	const islands = readIslands(map, readNodes(graphFields), notes);
	const islandIds: ReadonlySet<string> = new Set(islands.map(({ id }) => id));
	const routes = readRoutes(
		[
			["graph edges", listOf(graphFields?.edges), edgeStrength],
			["map routes", listOf(map.routes), routeStrength],
		],
		islandIds,
		notes
	);
	const foundations = uniqueById(
		listOf(map.foundations).map((value, index) =>
			readFoundation(value, index, islandIds, notes)
		),
		"foundation",
		notes
	);
	const foundationIds: ReadonlySet<string> = new Set(
		foundations.map(({ id }) => id)
	);
	const groups = uniqueById(
		listOf(map.groups).map((value, index) =>
			readGroup(value, index, islandIds, foundationIds, notes)
		),
		"group",
		notes
	);
	const suppliers = uniqueById(
		listOf(map.internalFoundations).map((value, index) =>
			readSupplier(value, index, islandIds, notes)
		),
		"supplier",
		notes
	);
	const { districts, imports, modules } = readInternals(
		internals,
		islands,
		notes
	);
	noteUncarried(map, notes);

	const zero: Extent = { height: 0, width: 0 };
	const land = chartBounds({ extent: zero, islands });
	const extent = readExtent(map, land, islands.length > 0, notes);
	const source = isText(map.inputKey)
		? { key: map.inputKey, kind: "foundry" as const, notes: notes.lines() }
		: { kind: "foundry" as const, notes: notes.lines() };
	return {
		districts,
		extent,
		foundations,
		groups,
		imports,
		islands,
		modules,
		routes,
		source,
		suppliers,
		version: CHART_VERSION,
	};
}
