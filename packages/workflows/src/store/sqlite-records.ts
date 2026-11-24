import {
  describeNumber,
  RecordFault,
  storableNumber,
  storableText,
  UNSTORABLE_TEXT,
} from "@foundry/lib/sqlite";
import type { z } from "zod";

import { runCheckedAs } from "../execution-records";
import { defineOwnEntry } from "../own-entry";
import type {
  JobRecord,
  QueueRecord,
  RunFrame,
  RunRecord,
  SuspensionRecord,
} from "../schema";
import {
  JobRecordSchema,
  QueueRecordSchema,
  RunFrameSchema,
  RunRecordSchema,
  RunRecordShapeSchema,
  SuspensionRecordSchema,
} from "../schema";

type FieldKind = "integer" | "json" | "optional" | "text";

export interface RecordKind<T> {
  readonly checkedAs?: (record: Readonly<Record<string, unknown>>) => unknown;
  readonly explain?: z.ZodType;
  readonly fields: Readonly<Record<string, FieldKind>>;
  readonly label: string;
  readonly schema: z.ZodType<T>;
  readonly undeclared: boolean;
}

export const QUEUE: RecordKind<QueueRecord> = {
  fields: {
    createdAt: "integer",
    extensions: "json",
    id: "text",
    lastError: "json",
    name: "text",
    status: "text",
  },
  label: "a Queue",
  schema: QueueRecordSchema,
  undeclared: false,
};

export const JOB: RecordKind<JobRecord> = {
  fields: {
    definition: "json",
    id: "text",
    input: "json",
    links: "json",
    status: "text",
    timestamps: "json",
  },
  label: "a Job",
  schema: JobRecordSchema,
  undeclared: false,
};

export const RUN: RecordKind<RunRecord> = {
  checkedAs: runCheckedAs,
  explain: RunRecordShapeSchema,
  fields: {
    definition: "optional",
    error: "json",
    extensions: "json",
    id: "text",
    input: "json",
    links: "optional",
    metadata: "json",
    output: "json",
    queueId: "text",
    snapshot: "json",
    status: "text",
    step: "text",
    tags: "json",
    timestamps: "json",
  } satisfies Record<keyof typeof RunRecordShapeSchema.shape, FieldKind>,
  label: "a Run",
  schema: RunRecordSchema,
  undeclared: true,
};

export const SUSPENSION: RecordKind<SuspensionRecord> = {
  fields: {
    id: "text",
    kind: "text",
    name: "text",
    occurrence: "integer",
    reason: "text",
    request: "json",
    resolution: "json",
    revision: "integer",
    runId: "text",
    status: "text",
    stepPath: "json",
    timestamps: "json",
  },
  label: "a Suspension",
  schema: SuspensionRecordSchema,
  undeclared: false,
};

export const FRAME: RecordKind<RunFrame> = {
  fields: { at: "integer", cursor: "integer", payload: "json", runId: "text" },
  label: "a Run frame",
  schema: RunFrameSchema,
  undeclared: false,
};

export interface KeptRecord<T> {
  readonly record: T;
  readonly undeclared: Record<string, unknown> | null;
}

export function kept<T>(kind: RecordKind<T>, value: unknown): KeptRecord<T> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RecordFault("", `holds ${describe(value)}, not ${kind.label}`);
  }
  const { declared, rest } = splitFields(kind, value);
  const record: Record<string, unknown> = {};
  for (const [key, fieldKind] of Object.entries(kind.fields)) {
    if (Object.hasOwn(declared, key)) {
      defineOwnEntry(record, key, declared[key]);
    } else if (fieldKind !== "optional") {
      throw new RecordFault(key, "is missing");
    }
  }
  for (const key of Object.keys(rest)) {
    defineOwnEntry(record, key, rest[key]);
  }
  accepted(kind, record);
  return {
    record: record as T,
    undeclared: Object.keys(rest).length === 0 ? null : rest,
  };
}

function splitFields(
  kind: RecordKind<unknown>,
  value: object
): { declared: Record<string, unknown>; rest: Record<string, unknown> } {
  const declared: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (field === undefined) {
      throw new RecordFault(keyPath("", key), UNDEFINED);
    }
    const fieldKind = Object.hasOwn(kind.fields, key)
      ? kind.fields[key]
      : undefined;
    if (fieldKind !== undefined) {
      defineOwnEntry(declared, key, fieldOf(key, fieldKind, field));
    } else if (kind.undeclared) {
      defineOwnEntry(rest, key, jsonOf(keyPath("", key), field, new Set()));
    } else {
      throw new RecordFault(
        keyPath("", key),
        `is no field of ${kind.label}, and SQLite has no column for it`
      );
    }
  }
  return { declared, rest };
}

function accepted(
  kind: RecordKind<unknown>,
  record: Readonly<Record<string, unknown>>
): void {
  const candidate = kind.checkedAs?.(record) ?? record;
  const checked = kind.schema.safeParse(candidate);
  if (checked.success) {
    return;
  }
  const explained = kind.explain?.safeParse(candidate);
  const [issue] =
    explained?.success === false
      ? explained.error.issues
      : checked.error.issues;
  throw new RecordFault(
    issue === undefined ? "" : issue.path.map(String).join("."),
    `is not ${kind.label} its schema accepts: ${issue?.message ?? "invalid"}`
  );
}

function fieldOf(key: string, fieldKind: FieldKind, value: unknown): unknown {
  switch (fieldKind) {
    case "text":
      return textOf(key, value);
    case "integer":
      return integerOf(key, value);
    case "optional":
      if (value === null) {
        throw new RecordFault(
          key,
          "null reads back from SQLite as the field left out; leave the field out instead"
        );
      }
      return jsonOf(key, value, new Set());
    default:
      return jsonOf(key, value, new Set());
  }
}

const UNDEFINED =
  "a property holding undefined does not read back from SQLite; leave the field out";

function textOf(path: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new RecordFault(path, `holds ${describe(value)}, not text`);
  }
  if (!storableText(value)) {
    throw new RecordFault(path, UNSTORABLE_TEXT);
  }
  return value;
}

function integerOf(path: string, value: unknown): number {
  if (typeof value !== "number") {
    throw new RecordFault(path, `holds ${describe(value)}, not a number`);
  }
  if (!storableNumber(value)) {
    throw new RecordFault(
      path,
      `${describeNumber(value)} does not read back intact from SQLite; it must be a number within ±Number.MAX_SAFE_INTEGER, and not -0`
    );
  }
  return value;
}

const PLAIN_KEY = /^[A-Za-z_$][\w$]*$/;

function keyPath(at: string, key: string): string {
  if (PLAIN_KEY.test(key)) {
    return at === "" ? key : `${at}.${key}`;
  }
  return `${at}[${JSON.stringify(key)}]`;
}

function jsonOf(at: string, value: unknown, ancestors: Set<object>): unknown {
  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      if (!Number.isFinite(value) || Object.is(value, -0)) {
        throw new RecordFault(
          at,
          `${describeNumber(value)} does not read back intact from JSON`
        );
      }
      return value;
    case "object":
      return value === null ? null : compositeOf(at, value, ancestors);
    default:
      throw new RecordFault(
        at,
        `${value === undefined ? "undefined" : `a ${typeof value}`} has no JSON form`
      );
  }
}

function compositeOf(
  at: string,
  value: object,
  ancestors: Set<object>
): unknown {
  if (ancestors.has(value)) {
    throw new RecordFault(at, "a value that contains itself has no JSON form");
  }
  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? arrayOf(at, value, ancestors)
      : objectOf(at, value, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function arrayOf(
  at: string,
  value: readonly unknown[],
  ancestors: Set<object>
): unknown[] {
  const copy: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const path = `${at}[${index}]`;
    if (!Object.hasOwn(value, index)) {
      throw new RecordFault(
        path,
        "a hole in an array reads back from JSON as null"
      );
    }
    const item = value[index];
    if (item === undefined) {
      throw new RecordFault(
        path,
        "undefined in an array reads back from JSON as null"
      );
    }
    copy.push(jsonOf(path, item, ancestors));
  }
  return copy;
}

function objectOf(
  at: string,
  value: object,
  ancestors: Set<object>
): Record<string, unknown> {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    const name = (value as { constructor?: { name?: unknown } }).constructor
      ?.name;
    throw new RecordFault(
      at,
      `${typeof name === "string" && name !== "" ? `a ${name}` : "an object that is not plain"} does not read back intact from JSON`
    );
  }
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) {
      throw new RecordFault(keyPath(at, key), UNDEFINED);
    }
    defineOwnEntry(copy, key, jsonOf(keyPath(at, key), item, ancestors));
  }
  return copy;
}

export function describe(value: unknown): string {
  if (typeof value === "number") {
    return describeNumber(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  if (typeof value === "object" && value !== null) {
    return "an object";
  }
  return String(value);
}
