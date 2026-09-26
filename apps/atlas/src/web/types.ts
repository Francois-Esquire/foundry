import type { Neighborhood } from "./neighborhoods";

export interface AtlasSymbol {
  id: string;
  name: string;
}

export interface AtlasFile {
  architectureKind?: "commons" | "junction" | "mixed" | "unknown";
  directory: string;
  id: string;
  incoming: number;
  kind: string;
  outgoing: number;
  path: string;
  x: number;
  y: number;
}

export type Polygon = [number, number][][];

export interface Territory {
  analyzed: boolean;
  coast: Polygon[];
  color: string;
  files: AtlasFile[];
  hills: Polygon[];
  id: string;
  label: string;
  neighborhoods: Neighborhood[];
  radius: number;
  shallows: Polygon[];
  x: number;
  y: number;
}

export interface AtlasRoute {
  from: string;
  sharedConcepts: number;
  to: string;
  weight: number;
}

export interface FormerPackage {
  id: string;
  label: string;
  lastObserved: string;
  x: number;
  y: number;
}

export interface AtlasData {
  coverage: string;
  declaredDependencies?: {
    from: string;
    to: string;
    kind:
      | "dependencies"
      | "devDependencies"
      | "peerDependencies"
      | "optionalDependencies";
  }[];
  fileEdges: { source: string; target: string }[];
  formerPackages?: FormerPackage[];
  generatedAt: string;
  height: number;
  routes: AtlasRoute[];
  territories: Territory[];
  width: number;
}
