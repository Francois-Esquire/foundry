import type { SessionMessage, SessionRecord } from "../schema";
import { MESSAGE_STATUSES, SESSION_ROLES, SESSION_STATUSES } from "../schema";
import type { SessionStoreWrite } from "./index";
import type { agentMessages, agentSessions } from "./tables";

/**
 * How `SqliteSessionStore` turns records into rows and back. Each record
 * field is one column, as the record holds it; what SQLite or JSON would
 * not give back intact is refused, naming the field, before any statement
 * runs. A storage limit of the SQLite store, not a rule of the package.
 */

/** A session row, `scope` included. */
export type SessionRow = typeof agentSessions.$inferSelect;

/** A message row before the commit places it in its session. */
export type UnplacedMessageRow = Omit<
  typeof agentMessages.$inferSelect,
  "position"
>;

/** Every row a write puts, in the order the write puts them. */
export interface WriteRows {
  readonly messages: readonly UnplacedMessageRow[];
  readonly sessions: readonly SessionRow[];
}

/**
 * The rows `write` puts in `scope`. Throws a `RangeError` naming the first
 * field SQLite would not give back intact, such as `putMessages[2].role`
 * or `putMessages[0].parts[3].output.items[1]`. It reads every field the
 * write puts, so a field that throws when read rejects the write too. The
 * JSON columns get plain copies, so the rows share nothing with `write`.
 */
export function rowsOf(scope: string, write: SessionStoreWrite): WriteRows {
  return {
    messages: (write.putMessages ?? []).map((message, index) =>
      messageRow(scope, `putMessages[${index}]`, message)
    ),
    sessions: (write.putSessions ?? []).map((session, index) =>
      sessionRow(scope, `putSessions[${index}]`, session)
    ),
  };
}

function sessionRow(
  scope: string,
  at: string,
  session: SessionRecord
): SessionRow {
  return {
    createdAt: integerOf(`${at}.createdAt`, session.createdAt),
    id: textOf(`${at}.id`, session.id),
    parentMessageId: linkOf(`${at}.parentMessageId`, session.parentMessageId),
    parentSessionId: linkOf(`${at}.parentSessionId`, session.parentSessionId),
    recursionDepth:
      session.recursionDepth === undefined
        ? null
        : integerOf(`${at}.recursionDepth`, session.recursionDepth),
    scope,
    status: textOf(`${at}.status`, session.status),
    title: session.title === null ? null : textOf(`${at}.title`, session.title),
    updatedAt: integerOf(`${at}.updatedAt`, session.updatedAt),
  };
}

function messageRow(
  scope: string,
  at: string,
  message: SessionMessage
): UnplacedMessageRow {
  return {
    createdAt: integerOf(`${at}.createdAt`, message.createdAt),
    id: textOf(`${at}.id`, message.id),
    metadata:
      message.metadata === undefined
        ? null
        : (jsonOf(
            `${at}.metadata`,
            message.metadata,
            new Set()
          ) as SessionMessage["metadata"] & object),
    parts: jsonOf(
      `${at}.parts`,
      message.parts,
      new Set()
    ) as SessionMessage["parts"],
    role: textOf(`${at}.role`, message.role),
    scope,
    sessionId: textOf(`${at}.sessionId`, message.sessionId),
    status: textOf(`${at}.status`, message.status),
    summarized: message.summarized ?? null,
    updatedAt: integerOf(`${at}.updatedAt`, message.updatedAt),
  };
}

/** The record a session row holds; NULL `recursion_depth` is the field left out. */
export function sessionOf(
  row: Omit<SessionRow, "scope">,
  scope: string
): SessionRecord {
  if (!SESSION_STATUSES.includes(row.status)) {
    throw unreadable(
      `session ${JSON.stringify(row.id)} in scope ${JSON.stringify(scope)}`,
      `column status holds ${JSON.stringify(row.status)}, which is no session status`
    );
  }
  return {
    createdAt: row.createdAt,
    id: row.id,
    parentMessageId: row.parentMessageId,
    parentSessionId: row.parentSessionId,
    ...(row.recursionDepth === null
      ? {}
      : { recursionDepth: row.recursionDepth }),
    status: row.status,
    title: row.title,
    updatedAt: row.updatedAt,
  };
}

/**
 * The record a message row holds; NULL `metadata` or `summarized` is the
 * field left out. Rejects a row this store would not have written, naming
 * the scope, the session, the message, and the column at fault.
 */
export function messageOf(
  row: Omit<UnplacedMessageRow, "scope">,
  scope: string
): SessionMessage {
  const fault = messageFault(row);
  if (fault !== undefined) {
    throw unreadable(
      `message ${JSON.stringify(row.id)} of session ${JSON.stringify(row.sessionId)} in scope ${JSON.stringify(scope)}`,
      fault
    );
  }
  return {
    createdAt: row.createdAt,
    id: row.id,
    ...(row.metadata === null ? {} : { metadata: row.metadata }),
    parts: row.parts,
    role: row.role,
    sessionId: row.sessionId,
    status: row.status,
    ...(row.summarized === null ? {} : { summarized: row.summarized }),
    updatedAt: row.updatedAt,
  };
}

function messageFault(
  row: Omit<UnplacedMessageRow, "scope">
): string | undefined {
  if (!SESSION_ROLES.includes(row.role)) {
    return `column role holds ${JSON.stringify(row.role)}, which is no role`;
  }
  if (!MESSAGE_STATUSES.includes(row.status)) {
    return `column status holds ${JSON.stringify(row.status)}, which is no message status`;
  }
  if (!Array.isArray(row.parts)) {
    return "column parts holds JSON that is not an array";
  }
  if (
    row.metadata !== null &&
    (typeof row.metadata !== "object" || Array.isArray(row.metadata))
  ) {
    return "column metadata holds JSON that is not an object";
  }
}

function unreadable(what: string, fault: string): Error {
  return new Error(`SqliteSessionStore cannot read ${what}: ${fault}`);
}

const TEXT =
  "text holding U+0000 or a lone surrogate (not well-formed UTF-16) does not read back intact from SQLite";

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

function refuse(field: string, reason: string): never {
  throw new RangeError(`SqliteSessionStore cannot store ${field}: ${reason}`);
}

function textOf<T extends string>(field: string, value: T): T {
  return storable(value) ? value : refuse(field, TEXT);
}

/**
 * A parent link. The record tells `null` (a root session) from the field
 * left out, and one nullable column cannot, so the field left out is
 * refused; `Sessions` always writes `null`.
 */
function linkOf(
  field: string,
  value: string | null | undefined
): string | null {
  if (value === undefined) {
    return refuse(
      field,
      "a field left out reads back from SQLite as null, which the record tells apart; write null for a root session"
    );
  }
  return value === null ? null : textOf(field, value);
}

/**
 * An integer field. SQLite does not give back NaN or an infinity (libSQL
 * refuses to bind them), `-0` (it reads back as `0`), or an integer beyond
 * `Number.MAX_SAFE_INTEGER` either way (an integer column keeps it as a
 * 64-bit integer libSQL then refuses to read, which would break every read
 * of the row). Every other number, whole or fractional, reads back exactly.
 */
function integerOf(field: string, value: number): number {
  return !Object.is(value, -0) && Math.abs(value) <= Number.MAX_SAFE_INTEGER
    ? value
    : refuse(
        field,
        `${describeNumber(value)} does not read back intact from SQLite; it must be a number within ±Number.MAX_SAFE_INTEGER, and not -0`
      );
}

function describeNumber(value: number): string {
  return Object.is(value, -0) ? "-0" : String(value);
}

/** A key that reads plainly after a dot in a path. */
const PLAIN_KEY = /^[A-Za-z_$][\w$]*$/;

function keyPath(at: string, key: string): string {
  return PLAIN_KEY.test(key) ? `${at}.${key}` : `${at}[${JSON.stringify(key)}]`;
}

/**
 * A plain copy of `value` that JSON gives back as it is, or a refusal naming
 * the first part that it would not: NaN, an infinity or `-0` (JSON writes
 * `null`, `null` and `0`), `undefined`, a hole or a function in an array
 * (`null`), a `bigint` or a value that contains itself (JSON throws), and
 * anything but a plain object or an array (a `Date` becomes a string, a
 * `Map` an empty object). A property holding `undefined` is left out, as
 * JSON leaves it out. Strings need no check: JSON escapes U+0000 and lone
 * surrogates, and reads them back intact.
 */
function jsonOf(at: string, value: unknown, ancestors: Set<object>): unknown {
  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      return Number.isFinite(value) && !Object.is(value, -0)
        ? value
        : refuse(
            at,
            `${describeNumber(value)} does not read back intact from JSON`
          );
    case "object":
      return value === null ? null : compositeOf(at, value, ancestors);
    default:
      return refuse(
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
    return refuse(at, "a value that contains itself has no JSON form");
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
      return refuse(path, "a hole in an array reads back from JSON as null");
    }
    const item = value[index];
    if (item === undefined) {
      return refuse(path, "undefined in an array reads back from JSON as null");
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
    return refuse(
      at,
      `${typeof name === "string" && name !== "" ? `a ${name}` : "an object that is not plain"} does not read back intact from JSON`
    );
  }
  const entries: [string, unknown][] = [];
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      entries.push([key, jsonOf(keyPath(at, key), item, ancestors)]);
    }
  }
  // `fromEntries` defines each key as its own property, `__proto__` too.
  return Object.fromEntries(entries);
}
