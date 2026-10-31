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
  /**
   * The app is being stopped and started again under changed access (a
   * network Grant change): `origin` stops serving until the next session.
   */
  restarting?: true;
  views: ModuleView[];
}

export interface ModuleSourceRevision {
  artifactId: string;
  contentId: string;
  updatedAt: string;
}

/** Whether two bindings name the same saved revision of a Module's source. */
export function sameRevision(
  left: ModuleSourceRevision,
  right: ModuleSourceRevision
): boolean {
  return (
    left.artifactId === right.artifactId &&
    left.contentId === right.contentId &&
    left.updatedAt === right.updatedAt
  );
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
  | { phase: "restarting" }
  | { phase: "failed"; message: string }
  | { phase: "ready"; app: ModuleSession };
