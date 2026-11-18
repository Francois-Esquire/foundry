export const OBSERVATION = {
  access: "access",
  attempt: "attempt",
  create: "create",
  gateway: "gateway",
  gatewayUnrecorded: "gateway-unrecorded",
  import: "import",
  power: "power",
  revise: "revise",
  save: "save",
  select: "select",
  settings: "settings",
} as const;

export type SaveActor = "build" | "disk" | "module" | "user";

// biome-ignore lint/style/useConsistentTypeDefinitions: A type alias is assignable to the JSON observation data an interface is not.
export type SourceSaveEvidence = {
  readonly actor: "build" | "disk" | "user";
  readonly artifactId: string;
  readonly contentId: string;
  readonly kind: "release" | "source";
  readonly moduleId: string;
  readonly recoveredFrom?: string;
  readonly tag?: string;
  readonly updatedAt: string;
};

// biome-ignore lint/style/useConsistentTypeDefinitions: A type alias is assignable to the JSON observation data an interface is not.
export type FileSaveEvidence = {
  readonly actor: "disk" | "module" | "user";
  readonly artifactId: string;
  readonly bytes: number;
  readonly contentId: string;
  readonly digest: string;
  readonly input: string;
  readonly kind: "file";
  readonly moduleId?: string;
  readonly operation: string;
  readonly path: string | null;
  readonly recoveredFrom?: string;
  readonly updatedAt: string;
};

export type SaveEvidence = FileSaveEvidence | SourceSaveEvidence;

// biome-ignore lint/style/useConsistentTypeDefinitions: A type alias is assignable to the JSON observation data an interface is not.
export type SaveAttempt = {
  readonly artifactId: string | null;
  readonly kind: "file";
  readonly outcome:
    | "conflict"
    | "denied"
    | "failed"
    | "refused"
    | "stale"
    | "uncertain";
};

// biome-ignore lint/style/useConsistentTypeDefinitions: A type alias is assignable to the JSON observation data an interface is not.
type ModuleAdded = {
  readonly artifactId: string;
  readonly moduleId: string;
};

// biome-ignore lint/style/useConsistentTypeDefinitions: A type alias is assignable to the JSON observation data an interface is not.
type FileRevised = {
  readonly artifactId: string;
  readonly contentId: string;
  readonly from: string;
};

// biome-ignore lint/style/useConsistentTypeDefinitions: A type alias is assignable to the JSON observation data an interface is not.
export type GatewayCall = {
  readonly capability?: string;
  readonly mode: string;
  readonly runtimeInstanceId: string;
  readonly version?: number;
};

// biome-ignore lint/style/useConsistentTypeDefinitions: A type alias is assignable to the JSON observation data an interface is not.
export type UnrecordedGatewayCalls = {
  readonly count: number;
};

export interface WorksResults {
  readonly [OBSERVATION.attempt]: SaveAttempt;
  readonly [OBSERVATION.create]: ModuleAdded | SaveEvidence;
  readonly [OBSERVATION.import]: ModuleAdded;
  readonly [OBSERVATION.revise]: FileRevised;
  readonly [OBSERVATION.save]: SaveEvidence;
}

interface Recorded {
  readonly data?: unknown;
  readonly kind: string;
  readonly type?: string;
}

const SOURCE_ACTORS: ReadonlySet<unknown> = new Set(["build", "disk", "user"]);
const FILE_ACTORS: ReadonlySet<unknown> = new Set(["disk", "module", "user"]);
const ATTEMPT_OUTCOMES: ReadonlySet<unknown> = new Set([
  "conflict",
  "denied",
  "failed",
  "refused",
  "stale",
  "uncertain",
]);

function dataOf(
  observation: Recorded,
  kind: string,
  types: readonly string[]
): Readonly<Record<string, unknown>> | null {
  const { data } = observation;
  return observation.kind === kind &&
    observation.type !== undefined &&
    types.includes(observation.type) &&
    typeof data === "object" &&
    data !== null &&
    !Array.isArray(data)
    ? (data as Readonly<Record<string, unknown>>)
    : null;
}

export function savedEvidence(observation: Recorded): SaveEvidence | null {
  const data = dataOf(observation, "result", [
    OBSERVATION.save,
    OBSERVATION.create,
  ]);
  if (
    !data ||
    typeof data.artifactId !== "string" ||
    typeof data.contentId !== "string" ||
    typeof data.updatedAt !== "string"
  ) {
    return null;
  }
  if (data.kind === "file") {
    return FILE_ACTORS.has(data.actor) && typeof data.operation === "string"
      ? (data as FileSaveEvidence)
      : null;
  }
  return (data.kind === "source" || data.kind === "release") &&
    SOURCE_ACTORS.has(data.actor) &&
    typeof data.moduleId === "string"
    ? (data as SourceSaveEvidence)
    : null;
}

export function fileSaveEvidence(
  observation: Recorded
): FileSaveEvidence | null {
  const evidence = savedEvidence(observation);
  return evidence?.kind === "file" ? evidence : null;
}

export function saveAttempt(observation: Recorded): SaveAttempt | null {
  const data = dataOf(observation, "result", [OBSERVATION.attempt]);
  return data && ATTEMPT_OUTCOMES.has(data.outcome)
    ? (data as SaveAttempt)
    : null;
}

export function gatewayCall(observation: Recorded): GatewayCall | null {
  const data = dataOf(observation, "effect", [OBSERVATION.gateway]);
  return data && typeof data.mode === "string" ? (data as GatewayCall) : null;
}

export function unrecordedGatewayCalls(observation: Recorded): number {
  const data = dataOf(observation, "effect", [OBSERVATION.gatewayUnrecorded]);
  return typeof data?.count === "number" ? data.count : 0;
}
