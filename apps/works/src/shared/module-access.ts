/** Where an approved request's scope shows in Access, and what it is called there. */
export const SCOPE_AREAS = {
  artifacts: "Artifact types",
  workflows: "Workflows",
} as const;

export type ScopeArea = keyof typeof SCOPE_AREAS;

/**
 * One Module's Access as main reports it: what its Version requests, what
 * the user approved, and the scope that leaves the Module with. Approval and
 * revocation happen only here; Module settings never grant authority.
 */
export interface ModuleAccessView {
  /** Grants the Installation holds, including any its Version no longer requests. */
  readonly grants: readonly {
    readonly capability: string;
    /** Whether it still approves a request of `version`. */
    readonly current: boolean;
    /** A network Grant restarts the app when it changes. */
    readonly kind: "capability" | "network";
    readonly version: number;
  }[];
  /** The Installation's lifecycle status; `null` before the Module has one. */
  readonly installation: {
    readonly status: "disabled" | "starting" | "active" | "stopping" | "failed";
  } | null;
  readonly moduleId: string;
  /**
   * Whether the app's private files outlive a stop (`installation`) or are
   * discarded (`none`), as `version` declares; null without a Version.
   */
  readonly privateFiles: "installation" | "none" | null;
  /** Each request of `version`, with whether a current Grant approves it. */
  readonly requests: readonly ModuleAccessRequestView[];
  /** What the Module may reach with its current Grants. */
  readonly scope: {
    /**
     * Artifact types the Module may also list, read and watch by id (its
     * approved `works.artifacts.list` scope). Empty: only files opened for
     * or created by the Module.
     */
    readonly artifacts: readonly string[];
    /** Approved released-app network destinations, as `host` or `host:port`. */
    readonly network: readonly string[];
    /** Host-registered workflows (`id@version`) the Module may start. */
    readonly workflows: readonly string[];
  };
  /**
   * The Version the requests come from: the Installation's selection, or the
   * newest release before the Module has an Installation.
   */
  readonly version: { readonly contentId: string; readonly tag: string } | null;
}

export interface ModuleAccessRequestView {
  readonly alias?: string;
  readonly approved: boolean;
  /** Whether this host can grant it: no provider, or constraints it refuses. */
  readonly availability: "available" | "unknown" | "denied";
  readonly capability: string;
  readonly destinations?: readonly string[];
  readonly kind: "capability" | "network";
  readonly reason: string;
  readonly required: boolean;
  /** What the request asks to reach: Artifact types, or workflows. */
  readonly scope?: {
    readonly area: ScopeArea;
    readonly reaches: readonly string[];
  };
  readonly version: number;
}
