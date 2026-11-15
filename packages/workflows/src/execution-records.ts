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
  RunFrame,
  RunFramePayload,
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
