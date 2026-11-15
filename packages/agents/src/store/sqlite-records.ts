import type { SessionMessage, SessionRecord } from "../schema";
import { MESSAGE_STATUSES, SESSION_ROLES, SESSION_STATUSES } from "../schema";
import { metadataFault, partsFault } from "./message-shape";

/**
 * What a record must be for `SqliteSessionStore` to keep it: one set of
 * checks, run on every record a commit puts (`./sqlite-rows`) and on every
 * record a row decodes to (`./sqlite-decode`). So anything written reads
 * back, and anything read back can be written again. Each check returns
 * an owned, plain copy of the record, or throws a {@link RecordFault}
 * naming the field below the record and what is wrong with it. A storage
 * limit of the SQLite store, not a rule of the package.
 */

/** A field of a record SQLite cannot keep as it is, and why. */
export class RecordFault extends Error {
  override readonly name = "RecordFault";
  /** The field below the record, such as `role` or `parts[2].input.n`; empty for the record itself. */
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

const TEXT =
  "text holding U+0000 or a lone surrogate (not well-formed UTF-16) does not read back intact from SQLite";
const UNDEFINED =
  "a property holding undefined does not read back from SQLite; leave the field out";
const LINK_LEFT_OUT =
  "a field left out reads back from SQLite as null, which the record tells apart; write null for a root session";

const SESSION_FIELDS = {
  optional: ["recursionDepth"],
  required: [
    "createdAt",
    "id",
    "parentMessageId",
    "parentSessionId",
    "status",
    "title",
    "updatedAt",
  ],
} as const;

const MESSAGE_FIELDS = {
  optional: ["metadata", "summarized"],
  required: [
    "createdAt",
    "id",
    "parts",
    "role",
    "sessionId",
    "status",
    "updatedAt",
  ],
} as const;

/** An owned copy of a session record SQLite keeps as it is, or a {@link RecordFault}. */
export function keptSession(value: unknown): SessionRecord {
  const fields = ownFields(value, SESSION_FIELDS, "a session record");
  for (const link of ["parentSessionId", "parentMessageId"] as const) {
    if (!Object.hasOwn(fields, link)) {
      throw new RecordFault(link, LINK_LEFT_OUT);
    }
  }
  missing(fields, SESSION_FIELDS.required);
  return {
    createdAt: integerOf("createdAt", fields.createdAt),
    id: textOf("id", fields.id),
    parentMessageId: nullableTextOf("parentMessageId", fields.parentMessageId),
    parentSessionId: nullableTextOf("parentSessionId", fields.parentSessionId),
    ...(Object.hasOwn(fields, "recursionDepth")
      ? { recursionDepth: integerOf("recursionDepth", fields.recursionDepth) }
      : {}),
    status: enumOf("status", fields.status, SESSION_STATUSES, "session status"),
    title: nullableTextOf("title", fields.title),
    updatedAt: integerOf("updatedAt", fields.updatedAt),
  };
}

/** An owned copy of a message SQLite keeps as it is, or a {@link RecordFault}. */
export function keptMessage(value: unknown): SessionMessage {
  const fields = ownFields(value, MESSAGE_FIELDS, "a message");
  missing(fields, MESSAGE_FIELDS.required);
  const id = textOf("id", fields.id);
  const sessionId = textOf("sessionId", fields.sessionId);
  const role = enumOf("role", fields.role, SESSION_ROLES, "role");
  const status = enumOf(
    "status",
    fields.status,
    MESSAGE_STATUSES,
    "message status"
  );
  const createdAt = integerOf("createdAt", fields.createdAt);
  const updatedAt = integerOf("updatedAt", fields.updatedAt);
  const parts = jsonOf("parts", fields.parts, new Set());
  shaped(partsFault(parts));
  const metadata = Object.hasOwn(fields, "metadata")
    ? jsonOf("metadata", fields.metadata, new Set())
    : undefined;
  shaped(metadataFault(metadata));
  return {
    createdAt,
    id,
    ...(metadata === undefined
      ? {}
      : { metadata: metadata as SessionMessage["metadata"] & object }),
    parts: parts as SessionMessage["parts"],
    role,
    sessionId,
    status,
    ...(Object.hasOwn(fields, "summarized")
      ? { summarized: booleanOf("summarized", fields.summarized) }
      : {}),
    updatedAt,
  };
}

/**
 * `value`'s own fields, read once each. Refuses a value that is not an
 * object, a field holding `undefined`, and a field the record does not
 * have, which no column would keep.
 */
function ownFields(
  value: unknown,
  known: {
    readonly optional: readonly string[];
    readonly required: readonly string[];
  },
  what: string
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RecordFault("", `holds ${describe(value)}, not ${what}`);
  }
  const fields: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (field === undefined) {
      throw new RecordFault(key, UNDEFINED);
    }
    if (!(known.required.includes(key) || known.optional.includes(key))) {
      throw new RecordFault(
        key,
        `is no field of ${what}, and SQLite has no column for it`
      );
    }
    fields[key] = field;
  }
  return fields;
}

function missing(
  fields: Record<string, unknown>,
  required: readonly string[]
): void {
  const absent = required.find((key) => !Object.hasOwn(fields, key));
  if (absent !== undefined) {
    throw new RecordFault(absent, "is missing");
  }
}

function shaped(fault: { path: string; reason: string } | undefined): void {
  if (fault !== undefined) {
    throw new RecordFault(fault.path, fault.reason);
  }
}

function textOf(path: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new RecordFault(path, `holds ${describe(value)}, not text`);
  }
  if (!storable(value)) {
    throw new RecordFault(path, TEXT);
  }
  return value;
}

function nullableTextOf(path: string, value: unknown): string | null {
  return value === null ? null : textOf(path, value);
}

function enumOf<T extends string>(
  path: string,
  value: unknown,
  values: readonly T[],
  what: string
): T {
  const text = textOf(path, value);
  if (!(values as readonly string[]).includes(text)) {
    throw new RecordFault(
      path,
      `holds ${JSON.stringify(text)}, which is no ${what}`
    );
  }
  return text as T;
}

function booleanOf(path: string, value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new RecordFault(path, `holds ${describe(value)}, not a boolean`);
  }
  return value;
}

/**
 * An integer field. SQLite does not give back NaN or an infinity (libSQL
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

function describeNumber(value: number): string {
  return Object.is(value, -0) ? "-0" : String(value);
}

function describe(value: unknown): string {
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

/** A key that reads plainly after a dot in a path. */
const PLAIN_KEY = /^[A-Za-z_$][\w$]*$/;

function keyPath(at: string, key: string): string {
  return PLAIN_KEY.test(key) ? `${at}.${key}` : `${at}[${JSON.stringify(key)}]`;
}

/**
 * A plain copy of `value` that JSON gives back as it is, or a refusal naming
 * the first part that it would not: NaN, an infinity or `-0` (JSON writes
 * `null`, `null` and `0`, and a number too large for a double parses to an
 * infinity), `undefined`, a hole or a function in an array (`null`), a
 * `bigint` or a value that contains itself (JSON throws), anything but a
 * plain object or an array (a `Date` becomes a string, a `Map` an empty
 * object), and a property holding `undefined` (JSON leaves it out).
 * Strings need no check: JSON escapes U+0000 and lone surrogates, and reads
 * them back intact.
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
  const entries: [string, unknown][] = [];
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) {
      throw new RecordFault(keyPath(at, key), UNDEFINED);
    }
    entries.push([key, jsonOf(keyPath(at, key), item, ancestors)]);
  }
  // `fromEntries` defines each key as its own property, `__proto__` too.
  return Object.fromEntries(entries);
}
