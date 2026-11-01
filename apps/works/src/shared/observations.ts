/**
 * What Works records on its engine runs: each observation `type` it writes
 * and the `data` that type carries. Main records them through these types;
 * main's recovery and the renderer's audit read them back through the
 * guards here, so writer and readers share one declaration. Plain data: no
 * engine import.
 */

/** Observation `type`s Works records. */
export const OBSERVATION = {
  /** A Grant approved or revoked. */
  access: "access",
  /** A save that wrote nothing, with its typed outcome. */
  attempt: "attempt",
  /** A Module, or a File Artifact with its first Content, created. */
  create: "create",
  /** One Gateway invocation of a released Program. */
  gateway: "gateway",
  /** Gateway invocations a long-lived Program counted but did not list. */
  gatewayUnrecorded: "gateway-unrecorded",
  /** A Module imported from a package. */
  import: "import",
  /** A Module switched on or off. */
  power: "power",
  /** A frozen File Artifact's ready working successor; not a save. */
  revise: "revise",
  /** A committed save of a File Artifact, Module source or release. */
  save: "save",
  /** A release selected for a Module's Installation. */
  select: "select",
  /** A Module's user settings changed. */
  settings: "settings",
} as const;

/** Who a committed save is attributed to. */
export type SaveActor = "build" | "disk" | "module" | "user";

/**
 * A committed Module source save or release, as its run records it. Source
 * is saved by a person (the Source editor or an accepted chat proposal) or
 * picked up from disk edits; a release is published by its build.
 */
// biome-ignore lint/style/useConsistentTypeDefinitions: A type alias is assignable to the JSON observation data an interface is not.
export type SourceSaveEvidence = {
  readonly actor: "build" | "disk" | "user";
  readonly artifactId: string;
  readonly contentId: string;
  /** Working source saved in place, or a frozen release Version. */
  readonly kind: "release" | "source";
  readonly moduleId: string;
  /** The run that made this save but could not record it, for a recovered save. */
  readonly recoveredFrom?: string;
  readonly tag?: string;
  readonly updatedAt: string;
};

/**
 * A committed File Artifact write. The latest one is also the `origin` on
 * its Content, so a missing record can be recovered from there.
 */
// biome-ignore lint/style/useConsistentTypeDefinitions: A type alias is assignable to the JSON observation data an interface is not.
export type FileSaveEvidence = {
  readonly actor: "disk" | "module" | "user";
  readonly artifactId: string;
  /** Size of the written entry (or of the whole tree for a disk write). */
  readonly bytes: number;
  readonly contentId: string;
  /** Digest of the written entry (or of the whole tree for a disk write). */
  readonly digest: string;
  /** The save's input, digested: a retried request must match it. */
  readonly input: string;
  readonly kind: "file";
  readonly moduleId?: string;
  /** The scoped request identity this write answered. */
  readonly operation: string;
  /** The entry written; null when a disk write changed the tree. */
  readonly path: string | null;
  /** Present on a recovery run: the run whose own result write failed. */
  readonly recoveredFrom?: string;
  readonly updatedAt: string;
};

/** Any committed save: a `save` (or a File Artifact's `create`) result. */
export type SaveEvidence = FileSaveEvidence | SourceSaveEvidence;

/**
 * A save that wrote nothing: an `attempt` result. Failed attempts are never
 * saves; a save run that threw carries its outcome in the run's error code.
 */
// biome-ignore lint/style/useConsistentTypeDefinitions: A type alias is assignable to the JSON observation data an interface is not.
export type SaveAttempt = {
  /** Null for a create that made no Artifact. */
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

/** A Module created or imported: a `create` or `import` result. */
// biome-ignore lint/style/useConsistentTypeDefinitions: A type alias is assignable to the JSON observation data an interface is not.
type ModuleAdded = {
  readonly artifactId: string;
  readonly moduleId: string;
};

/** A frozen File Artifact's working successor: a `revise` result. */
// biome-ignore lint/style/useConsistentTypeDefinitions: A type alias is assignable to the JSON observation data an interface is not.
type FileRevised = {
  readonly artifactId: string;
  readonly contentId: string;
  /** The frozen Content it holds the files of. */
  readonly from: string;
};

/**
 * One Gateway invocation: a `gateway` effect. Capability, timing and
 * outcome only, never input or output.
 */
// biome-ignore lint/style/useConsistentTypeDefinitions: A type alias is assignable to the JSON observation data an interface is not.
export type GatewayCall = {
  /** Absent when the invocation named no declared Capability. */
  readonly capability?: string;
  readonly mode: string;
  readonly runtimeInstanceId: string;
  readonly version?: number;
};

/** A `gateway-unrecorded` effect: invocations counted, not listed. */
// biome-ignore lint/style/useConsistentTypeDefinitions: A type alias is assignable to the JSON observation data an interface is not.
export type UnrecordedGatewayCalls = {
  readonly count: number;
};

/** The `data` of each `result` observation type Works reads back. */
export interface WorksResults {
  readonly [OBSERVATION.attempt]: SaveAttempt;
  readonly [OBSERVATION.create]: ModuleAdded | SaveEvidence;
  readonly [OBSERVATION.import]: ModuleAdded;
  readonly [OBSERVATION.revise]: FileRevised;
  readonly [OBSERVATION.save]: SaveEvidence;
}

/** The parts of a recorded observation the guards read. */
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

/** The committed save an observation records, or null for anything else. */
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

/** The File Artifact write an observation records, or null for anything else. */
export function fileSaveEvidence(
  observation: Recorded
): FileSaveEvidence | null {
  const evidence = savedEvidence(observation);
  return evidence?.kind === "file" ? evidence : null;
}

/** The save attempt an observation records, or null for anything else. */
export function saveAttempt(observation: Recorded): SaveAttempt | null {
  const data = dataOf(observation, "result", [OBSERVATION.attempt]);
  return data && ATTEMPT_OUTCOMES.has(data.outcome)
    ? (data as SaveAttempt)
    : null;
}

/** The Gateway invocation an observation records, or null for anything else. */
export function gatewayCall(observation: Recorded): GatewayCall | null {
  const data = dataOf(observation, "effect", [OBSERVATION.gateway]);
  return data && typeof data.mode === "string" ? (data as GatewayCall) : null;
}

/** How many Gateway invocations an observation counted without listing them. */
export function unrecordedGatewayCalls(observation: Recorded): number {
  const data = dataOf(observation, "effect", [OBSERVATION.gatewayUnrecorded]);
  return typeof data?.count === "number" ? data.count : 0;
}
