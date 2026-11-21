export const SCOPE_AREAS = {
  artifacts: "Artifact types",
  workflows: "Workflows",
} as const;

export type ScopeArea = keyof typeof SCOPE_AREAS;

export interface ModuleAccessView {
  readonly grants: readonly {
    readonly capability: string;
    readonly current: boolean;
    readonly kind: "capability" | "network";
    readonly version: number;
  }[];
  readonly installation: {
    readonly status: "disabled" | "starting" | "active" | "stopping" | "failed";
  } | null;
  readonly moduleId: string;
  readonly privateFiles: "installation" | "none" | null;
  readonly requests: readonly ModuleAccessRequestView[];
  readonly scope: {
    readonly artifacts: readonly string[];
    readonly network: readonly string[];
    readonly workflows: readonly string[];
  };
  readonly version: { readonly contentId: string; readonly tag: string } | null;
}

export interface ModuleAccessRequestView {
  readonly alias?: string;
  readonly approved: boolean;
  readonly availability: "available" | "unknown" | "denied";
  readonly capability: string;
  readonly destinations?: readonly string[];
  readonly kind: "capability" | "network";
  readonly reason: string;
  readonly required: boolean;
  readonly scope?: {
    readonly area: ScopeArea;
    readonly reaches: readonly string[];
  };
  readonly version: number;
}
