import type { RuntimeObservation, Snapshot } from "@o/domain";

/** Same name as the domain Status, unrelated shape. */
export interface Status {
  ok: boolean;
}

export class StoredObservationNotFoundError extends Error {
  constructor(id: string) {
    super(`stored observation ${id} not found`);
  }
}

export class StoredObservationConflictError extends Error {
  constructor(
    readonly entity: string,
    readonly key: string,
    readonly hint: string,
  ) {
    super(`${entity} ${key} conflict: ${hint}`);
  }
}

export interface MarkerView {
  on: boolean;
}

export interface StoredRuntimeObservation {
  id: string;
  status: string;
  timestamp: number;
  output: string;
  attempts: number;
  createdAt: string;
}

export function toStored(value: RuntimeObservation): StoredRuntimeObservation {
  return { ...value, createdAt: "" };
}

export function fromStored(
  stored: StoredRuntimeObservation,
): RuntimeObservation {
  const { createdAt: _createdAt, ...rest } = stored;
  return rest;
}

/** Reshaped persistence row: few shared names, one explicit converter. */
export interface SnapshotRow {
  snapshotId: string;
  label: string;
  taken: number;
  statusCode: number;
}

export function rowToSnapshot(row: SnapshotRow): Snapshot {
  return {
    id: row.snapshotId,
    label: row.label,
    status: { code: row.statusCode, message: "" },
    taken: row.taken,
  };
}
