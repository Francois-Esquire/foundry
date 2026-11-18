export const CHART_VERSION = 2;

export type Point = readonly [x: number, y: number];

export type Ring = readonly Point[];

export interface Polygon {
  readonly holes: readonly Ring[];
  readonly outer: Ring;
}

export interface Shape {
  readonly coast: readonly Polygon[];
  readonly hills: readonly Polygon[];
  readonly shallows: readonly Polygon[];
}

export interface Island {
  readonly at: Point;
  readonly id: string;
  readonly layer: number | null;
  readonly name: string;
  readonly shape: Shape;
  readonly size: number;
}

export interface Route {
  readonly from: string;
  readonly kind: string;
  readonly strength: number;
  readonly to: string;
}

export interface Member {
  readonly direct: boolean;
  readonly distance: number;
  readonly island: string;
  readonly weight: number;
}

export interface Lobe {
  readonly at: Point;
  readonly island: string;
  readonly radius: number;
  readonly weight: number;
}

export interface Foundation {
  readonly at: Point;
  readonly id: string;
  readonly lobes: readonly Lobe[];
  readonly members: readonly Member[];
  readonly name: string;
  readonly prominence: number;
  readonly versions: readonly string[];
}

export interface Group {
  readonly foundations: readonly string[];
  readonly id: string;
  readonly islands: readonly string[];
}

export interface Supplier {
  readonly id: string;
  readonly island: string;
  readonly members: readonly Member[];
  readonly prominence: number;
}

export type ModuleKind =
  | "config"
  | "other"
  | "source"
  | "story"
  | "test"
  | "unknown";

export interface Change {
  readonly authors: number;
  readonly commits: number;
  readonly frequent: boolean;
  readonly linesChanged: number;
}

export interface Module {
  readonly at: Point;
  readonly change: Change | null;
  readonly districts: readonly string[] | null;
  readonly fanIn: number;
  readonly fanOut: number;
  readonly id: string;
  readonly island: string;
  readonly kind: ModuleKind;
  readonly role: "aggregator" | "internal" | null;
}

export interface Import {
  readonly crossing: boolean;
  readonly from: string;
  readonly to: string;
  readonly typeOnly: boolean;
}

export interface District {
  readonly anchor: string;
  readonly id: string;
  readonly island: string;
  readonly label: string;
  readonly modules: readonly string[];
}

export interface Extent {
  readonly height: number;
  readonly width: number;
}

interface Source {
  readonly key?: string;
  readonly kind: "foundry" | "spyglass" | "generated" | "dropped";
  readonly notes: readonly string[];
}

export interface Chart {
  readonly districts: readonly District[];
  readonly extent: Extent;
  readonly foundations: readonly Foundation[];
  readonly groups: readonly Group[];
  readonly imports: readonly Import[];
  readonly islands: readonly Island[];
  readonly modules: readonly Module[];
  readonly routes: readonly Route[];
  readonly source: Source;
  readonly suppliers: readonly Supplier[];
  readonly version: typeof CHART_VERSION;
}
