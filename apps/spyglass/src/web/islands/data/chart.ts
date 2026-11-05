/**
 * The chart: the one data structure the Islands experiment renders, and the
 * final form every source is converted into. Foundry's map and graph, the
 * Spyglass atlas, generated worlds and dropped files all become a `Chart`
 * through an adapter; nothing downstream knows where a chart came from.
 *
 * It is plain data: JSON-serialisable, no classes, no Maps, every reference
 * by id. It is static once made. It describes the workspace, never the
 * picture: no colours, no heights, no styles. Those are the renderer's
 * parameters.
 *
 * Space: chart units are the source's own map units, with the origin at the
 * chart's centre. `x` runs east, `y` runs south, as on a page. Every
 * coordinate is absolute; nothing is relative to an island.
 *
 * Rings are closed implicitly (no repeated closing point), have three or
 * more finite points, enclose some area, outer rings run counter-clockwise
 * and holes clockwise. Counter-clockwise is the shoelace sign in chart axes
 * (positive signed area, `ringArea` in `geometry.ts`); with `y` south it
 * looks clockwise on a page. Every id a chart references names something in
 * it, the extent is positive and holds every coast. Adapters guarantee all
 * of it, so consumers never validate.
 */

/**
 * The chart format. 2 added the islands' insides: modules, the imports
 * between them, and districts.
 */
export const CHART_VERSION = 2;

export type Point = readonly [x: number, y: number];

/** A closed ring of three or more points. */
export type Ring = readonly Point[];

/** One piece of land or water: its outline, then the holes cut out of it. */
export interface Polygon {
	readonly holes: readonly Ring[];
	readonly outer: Ring;
}

/**
 * An island's shape, in layers from the water up. Each is a set of
 * polygons filled even-odd; pieces may be several, as a cluster is. The
 * coast is the only required layer and the only one this iteration reads.
 */
export interface Shape {
	/** The land's edge: sea level. One or more pieces. */
	readonly coast: readonly Polygon[];
	/** Raised land inside the coast, never nested, carrying no level. */
	readonly hills: readonly Polygon[];
	/** Shallow water around the coast: the shelf. */
	readonly shallows: readonly Polygon[];
}

/** A package of the workspace, as land. Its files are `Chart.modules`. */
export interface Island {
	/** Where the island sits: the source's own placement. */
	readonly at: Point;
	/** Stable identity across sources, maps and sessions: the package id. */
	readonly id: string;
	/**
	 * Dependency depth in the workspace graph, 0 for leaves, higher for
	 * packages that depend on more. Null when the source has no graph.
	 */
	readonly layer: number | null;
	/** What to call it: the package's short name. */
	readonly name: string;
	readonly shape: Shape;
	/** A rough radius in chart units, for fitting and sorting; not geometry. */
	readonly size: number;
}

/** One island depending on another: directed, `from` depends on `to`. */
export interface Route {
	readonly from: string;
	/** What the source calls the relation; `"dependency"` for a package import. */
	readonly kind: string;
	/** How much travels the route: a module-edge count, 1 or more. */
	readonly strength: number;
	readonly to: string;
}

/**
 * An island's part in a foundation: how directly and how far away it
 * depends on the shared thing, and how much of it.
 */
export interface Member {
	/** Whether the island depends on it directly, or only through others. */
	readonly direct: boolean;
	/** Hops from the island to the shared dependency, 1 for direct. */
	readonly distance: number;
	readonly island: string;
	/** The island's share of the dependency, 0 or more; the source's measure. */
	readonly weight: number;
}

/** Where a foundation shows under one member: a lobe about the island. */
export interface Lobe {
	readonly at: Point;
	readonly island: string;
	readonly radius: number;
	readonly weight: number;
}

/**
 * Something outside the workspace that several islands stand on: an
 * external dependency. The sea floor's forms (plates, rings) come from
 * these. The source lays them out already; `at` and `lobes` keep that
 * layout so forms land where the source drew them.
 */
export interface Foundation {
	/** The centre of its lobes. */
	readonly at: Point;
	/** Stable identity, e.g. `dependency:zod`. */
	readonly id: string;
	readonly lobes: readonly Lobe[];
	readonly members: readonly Member[];
	/** The dependency's name as published. */
	readonly name: string;
	/** How much the workspace leans on it, higher for more; the source's scale. */
	readonly prominence: number;
	/** Versions in use across the members. */
	readonly versions: readonly string[];
}

/**
 * Islands that share exactly the same set of foundations: a cohort that
 * stands on the same ground. Derived by the source from the foundations,
 * kept because the renderer groups by it.
 */
export interface Group {
	/** The foundations the members share, by id. */
	readonly foundations: readonly string[];
	readonly id: string;
	/** Two or more islands, by id. */
	readonly islands: readonly string[];
}

/**
 * An island of the workspace that other islands stand on: an internal
 * supplier, the basement under its dependents. The same relation as a
 * foundation, but the shared thing is on the map.
 */
export interface Supplier {
	readonly id: string;
	/** The island supplying, by id. */
	readonly island: string;
	readonly members: readonly Member[];
	readonly prominence: number;
}

/** What kind of file a module is, as the source classes it. */
export type ModuleKind =
	| "config"
	| "other"
	| "source"
	| "story"
	| "test"
	| "unknown";

/** How a module's history reads: its changes over the source's window. */
export interface Change {
	readonly authors: number;
	readonly commits: number;
	/** Among the workspace's most often changed files of its kind. */
	readonly frequent: boolean;
	readonly linesChanged: number;
}

/** A file of an island's package, placed on the island. */
export interface Module {
	/** Where the file sits on its island: the source's own placement, absolute. */
	readonly at: Point;
	/** Its history, or null when the source read none. */
	readonly change: Change | null;
	/**
	 * The districts it belongs to, by id, or null for a file no district
	 * holds. Districts don't overlap in today's sources, so a list has one
	 * entry; the list leaves room for ones that do.
	 */
	readonly districts: readonly string[] | null;
	/** Modules importing it, across the workspace. */
	readonly fanIn: number;
	/** Modules it imports, across the workspace. */
	readonly fanOut: number;
	/** Stable identity: the file's workspace-relative path. */
	readonly id: string;
	/** The island whose package holds it. */
	readonly island: string;
	readonly kind: ModuleKind;
	/**
	 * `aggregator` when it re-exports at least as much as it declares (an
	 * index), `internal` otherwise, or null when the source didn't say.
	 */
	readonly role: "aggregator" | "internal" | null;
}

/** One module importing another: directed, `from` imports `to`. */
export interface Import {
	/** Between two islands' modules, not inside one island. */
	readonly crossing: boolean;
	readonly from: string;
	readonly to: string;
	/** Only types travel it: nothing of it runs. */
	readonly typeOnly: boolean;
}

/**
 * Modules of one island that belong together: the source's responsibility
 * group, inferred from the imports, symbols and folders they share.
 */
export interface District {
	/** The member most connected to the others, by module id. */
	readonly anchor: string;
	readonly id: string;
	readonly island: string;
	/** What to call it: a type, folder or file its members share. */
	readonly label: string;
	/** One or more modules of `island`, by id. */
	readonly modules: readonly string[];
}

/**
 * The chart's area, centred on the origin, in chart units: from
 * `-width / 2` to `width / 2` in x, the same in y with `height`. Both are
 * positive, and every coast lies inside.
 */
export interface Extent {
	readonly height: number;
	readonly width: number;
}

/** Where a chart came from, for the UI and for notes. */
export interface Source {
	/** The source's own identity for this data, if it has one. */
	readonly key?: string;
	readonly kind: "foundry" | "spyglass" | "generated" | "dropped";
	/** What the adapter left behind, one line each. */
	readonly notes: readonly string[];
}

export interface Chart {
	/** The islands' districts; empty when the source has no internals. */
	readonly districts: readonly District[];
	readonly extent: Extent;
	readonly foundations: readonly Foundation[];
	readonly groups: readonly Group[];
	/** Module-to-module imports; empty when the source has no internals. */
	readonly imports: readonly Import[];
	readonly islands: readonly Island[];
	/** Every island's files; empty when the source has no internals. */
	readonly modules: readonly Module[];
	readonly routes: readonly Route[];
	readonly source: Source;
	readonly suppliers: readonly Supplier[];
	readonly version: typeof CHART_VERSION;
}
