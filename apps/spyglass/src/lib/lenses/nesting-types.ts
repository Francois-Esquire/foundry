export const NESTING_SCHEMA_VERSION = 1;

export interface NestingFolder {
  fileCounts: { descendant: number; direct: number };
  id: string;
  package?: string;
  packageRoot: boolean;
  parent?: string;
  pathRegion?: string;
}

export interface NestingPathRegion {
  files: number;
  id: string;
  package: string;
  primaryFiles: number;
}

export interface NestingSeam {
  from: string;
  importSites: number;
  moduleEdges: number;
  package: string;
  symbolFlow: number;
  to: string;
}

export interface Nesting {
  folders: NestingFolder[];
  missing: string[];
  pathRegions: NestingPathRegion[];
  seams: NestingSeam[];
}
