export interface ModuleSummary {
  artifactId: string;
  id: string;
  name: string;
  updatedAt: string;
}

export interface ModuleDetails extends ModuleSummary {
  binding: ModuleSourceRevision | null;
  releases: ModuleRelease[];
  source: Record<string, string>;
}

interface ModuleView {
  id: string;
  path: string;
  title?: string;
}

export interface ModuleRelease {
  contentId: string;
  tag: string;
  views: ModuleView[];
}

export interface ModuleSession {
  origin: string;
  views: ModuleView[];
}

export interface ModuleSourceRevision {
  artifactId: string;
  contentId: string;
  updatedAt: string;
}

export type ModuleBuildEvent =
  | {
      phase:
        | "preparing"
        | "installing"
        | "generating"
        | "checking"
        | "building"
        | "publishing";
      log?: string;
    }
  | { phase: "failed"; message: string }
  | {
      phase: "complete";
      release: ModuleRelease;
      binding: ModuleSourceRevision;
    };

export type ModuleAppEvent =
  | { phase: "building"; step: string }
  | { phase: "starting" }
  | { phase: "failed"; message: string }
  | { phase: "ready"; app: ModuleSession };
