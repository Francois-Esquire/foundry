export interface Status {
  code: number;
  message: string;
}

export interface RuntimeObservation {
  id: string;
  status: string;
  timestamp: number;
  output: string;
  attempts: number;
}

/** Projection of RuntimeObservation: assignable from it, not to it. */
export interface RuntimeObservationSummary {
  id: string;
  status: string;
}

export interface Snapshot {
  id: string;
  label: string;
  status: Status;
  taken: number;
}

/** Same shape as Snapshot under a generic suffix. */
export interface SnapshotRecord {
  id: string;
  label: string;
  status: Status;
  taken: number;
}

export interface UserConfig {
  retries: number;
  theme: string;
}

export interface DatabaseConfig {
  host: string;
  port: number;
}

export type ObservationId = string;
export type SnapshotId = string;

export interface Repo {
  load(id: ObservationId): RuntimeObservation;
}

export class MemoryRepo implements Repo {
  load(id: ObservationId): RuntimeObservation {
    return { id, status: "ok", timestamp: 0, output: "", attempts: 0 };
  }
}

export function summarize(
  observation: RuntimeObservation,
): RuntimeObservationSummary {
  return { id: observation.id, status: observation.status };
}

export function snapshotsOf(
  observation: RuntimeObservation,
): Promise<Snapshot[]> {
  return Promise.resolve([
    {
      id: observation.id,
      label: observation.output,
      status: { code: 0, message: "" },
      taken: observation.timestamp,
    },
  ]);
}

/** Shares only inherited Error properties with the db error. */
export class ObservationNotFoundError extends Error {
  constructor(id: ObservationId) {
    super(`observation ${id} not found`);
  }
}

/** Own properties on both errors: the pair can overlap normally. */
export class ObservationConflictError extends Error {
  constructor(
    readonly entity: string,
    readonly key: string,
    readonly hint: string,
  ) {
    super(`${entity} ${key} conflict: ${hint}`);
  }
}

/** One-property shape mutually assignable with the db marker. */
export interface Marker {
  on: boolean;
}

export interface Alpha {
  id: string;
  name: string;
}
export interface Beta {
  id: string;
  name: string;
}
export interface Gamma {
  id: string;
  name: string;
}
export interface Delta {
  id: string;
  name: string;
}
export interface Epsilon {
  id: string;
  name: string;
}
export interface Zeta {
  id: string;
  name: string;
}
export interface Eta {
  id: string;
  name: string;
}
export interface Theta {
  id: string;
  name: string;
}
export interface Iota {
  id: string;
  name: string;
}
export interface Kappa {
  id: string;
  name: string;
}
export interface Lambda {
  id: string;
  name: string;
}
export interface Mu {
  id: string;
  name: string;
}
