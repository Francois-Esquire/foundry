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

const LEGACY_RUN_ID = "rn-legacy";

export function runCheckedAs<T extends Readonly<Record<string, unknown>>>(
  record: T
): T {
  return typeof record.id === "string" && !record.id.startsWith("rn-")
    ? { ...record, id: LEGACY_RUN_ID }
    : record;
}
