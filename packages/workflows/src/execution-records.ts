import type { JobRecord, RunRecord, SuspensionRecord } from "./schema";
import {
  JobRecordSchema,
  RunRecordSchema,
  SuspensionRecordSchema,
} from "./schema";

export type { JsonValue } from "./json-value";
export type {
  DefinitionReference,
  JobLinks,
  JobRecord,
  JobStatus,
  RunLinks,
  RunRecord,
  RunTimestamps,
  SuspensionRecord,
  SuspensionStatus,
} from "./schema";

export function decodeJobRecord(value: unknown): JobRecord {
  return JobRecordSchema.parse(value);
}

export function decodeRunRecord(value: unknown): RunRecord {
  return RunRecordSchema.parse(value);
}

export function decodeSuspensionRecord(value: unknown): SuspensionRecord {
  return SuspensionRecordSchema.parse(value);
}

/** The id a Run written before Run ids took the `rn-` prefix is checked as. */
const LEGACY_RUN_ID = "rn-legacy";

/**
 * `record` as `RunRecordSchema` checks it: a Run whose id predates the `rn-`
 * prefix is admitted, so its id stands in as one. Every other field is
 * checked as it is.
 */
export function runCheckedAs<T extends Readonly<Record<string, unknown>>>(
  record: T
): T {
  return typeof record.id === "string" && !record.id.startsWith("rn-")
    ? { ...record, id: LEGACY_RUN_ID }
    : record;
}
