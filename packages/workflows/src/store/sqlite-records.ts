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

/**
 * What a record must be for `SqliteWorkflowStore` to keep it: one set of
 * checks per record kind, run on every record a commit puts and on every
 * record a row decodes to. So anything written reads back, and anything
 * read back can be written again. Each check returns an owned, plain copy
 * of the record, or throws a {@link RecordFault} naming the field below the
 * record and what is wrong with it. A storage limit of the SQLite store,
 * not a rule of the package.
 */

/** A field of a record SQLite cannot keep as it is, and why. */
export class RecordFault extends Error {
  override readonly name = "RecordFault";
  /** The field below the record, such as `id` or `metadata.list[2]`; empty for the record itself. */
  readonly path: string;
  readonly reason: string;

  constructor(path: string, reason: string) {
    super(`${path || "(record)"}: ${reason}`);
    this.path = path;
    this.reason = reason;
  }
}

/** `path` below `at`, as one path. */
export function below(at: string, path: string): string {
  if (path === "") {
    return at;
  }
  return path.startsWith("[") ? `${at}${path}` : `${at}.${path}`;
}

/**
 * Whether SQLite gives `text` back as it was bound. It does not when the text
 * holds U+0000 (libSQL reads it back cut at the NUL) or is not well-formed
 * UTF-16: a lone surrogate is bound as U+FFFD on Node and as nothing on Bun,
 * so it reads back changed, and a key holding one would match another key's
 * row. JSON text is exempt: JSON escapes both.
 */
export function storable(text: string): boolean {
  return text.isWellFormed() && !text.includes("\u0000");
}

/**
 * How one top-level field is kept.
 *
 * - `text`: a plain text column.
 * - `integer`: an integer column, for epoch milliseconds and counters.
 * - `json`: a JSON column; NULL is a `null` value.
 * - `optional`: a JSON column for a field the record may leave out; NULL is
 *   the field left out, so the field may not hold `null`.
 */
type FieldKind = "integer" | "json" | "optional" | "text";

/** A record kind: its fields, how each is kept, and its schema. */
export interface RecordKind<T> {
  /**
   * The record as `schema` checks it, when that differs from the record
   * itself: a legacy Run id is checked as the coordinator checks it.
   */
  readonly checkedAs?: (record: Readonly<Record<string, unknown>>) => unknown;
  /**
   * A schema that names the field at fault when `schema` refuses a record
   * without saying which, as `RunRecordSchema` does.
   */
  readonly explain?: z.ZodType;
  readonly fields: Readonly<Record<string, FieldKind>>;
  /** What a record is called in a refusal, such as `a Run`. */
  readonly label: string;
  readonly schema: z.ZodType<T>;
  /** Whether fields the record does not declare are kept, in `undeclared`. */
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

/** Every field `RunRecordShapeSchema` declares; the rest go in `undeclared`. */
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

/** A record split into its declared fields and the ones it does not declare. */
export interface KeptRecord<T> {
  /** The owned copy: the declared fields in schema order, then the rest. */
  readonly record: T;
  /** The fields the record does not declare, or `null` when there are none. */
  readonly undeclared: Record<string, unknown> | null;
}

/**
 * An owned copy of `value` that SQLite keeps as it is, or a
 * {@link RecordFault}. It refuses a value that is not a plain object, a
 * field holding `undefined`, a required field left out, a field no column
 * would keep, a value of the wrong storage type, and a record its schema
 * refuses.
 */
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

/**
 * `value`'s own fields, each read once and copied as its column keeps it:
 * the declared ones, and the rest as JSON when the kind keeps them.
 */
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

/** Refuses a record its schema refuses, naming the field where it can. */
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

const TEXT =
  "text holding U+0000 or a lone surrogate (not well-formed UTF-16) does not read back intact from SQLite";
const UNDEFINED =
  "a property holding undefined does not read back from SQLite; leave the field out";

function textOf(path: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new RecordFault(path, `holds ${describe(value)}, not text`);
  }
  if (!storable(value)) {
    throw new RecordFault(path, TEXT);
  }
  return value;
}

/**
 * An integer column. SQLite does not give back NaN or an infinity (libSQL
 * refuses to bind them), `-0` (it reads back as `0`), or an integer beyond
 * `Number.MAX_SAFE_INTEGER` either way (an integer column keeps it as a
 * 64-bit integer libSQL then refuses to read, which would break every read
 * of the row). Every other number, whole or fractional, reads back exactly.
 */
function integerOf(path: string, value: unknown): number {
  if (typeof value !== "number") {
    throw new RecordFault(path, `holds ${describe(value)}, not a number`);
  }
  if (Object.is(value, -0) || !(Math.abs(value) <= Number.MAX_SAFE_INTEGER)) {
    throw new RecordFault(
      path,
      `${describeNumber(value)} does not read back intact from SQLite; it must be a number within ±Number.MAX_SAFE_INTEGER, and not -0`
    );
  }
  return value;
}

/** A key that reads plainly after a dot in a path. */
const PLAIN_KEY = /^[A-Za-z_$][\w$]*$/;

function keyPath(at: string, key: string): string {
  if (PLAIN_KEY.test(key)) {
    return at === "" ? key : `${at}.${key}`;
  }
  return `${at}[${JSON.stringify(key)}]`;
}

/**
 * A plain copy of `value` that JSON gives back as it is, or a refusal naming
 * the first part that it would not: NaN, an infinity or `-0` (JSON writes
 * `null`, `null` and `0`), `undefined`, a hole or a function in an array
 * (`null`), a `bigint` or a value that contains itself (JSON throws),
 * anything but a plain object or an array (a `Date` becomes a string, a
 * `Map` an empty object), and a property holding `undefined` (JSON leaves
 * it out). Strings need no check: JSON escapes U+0000 and lone surrogates,
 * and reads them back intact. A key named `__proto__` stays an own key.
 */
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

function describeNumber(value: number): string {
  return Object.is(value, -0) ? "-0" : String(value);
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
