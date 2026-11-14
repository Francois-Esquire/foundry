import type { SessionMessage, SessionRecord } from "../schema";
import { keptMessage, keptSession, RecordFault } from "./sqlite-records";

/**
 * How `SqliteSessionStore` reads a row back as a record: the one decoder.
 * It takes each column as SQLite returns it, the JSON columns as text and
 * `summarized` as an integer, turns the row into the record it holds, and
 * passes that through the checks every write passes (`./sqlite-records`).
 * So a record read back can be written again. It rejects a row it would not
 * have written, naming the scope, the session, the message and the column
 * or field at fault.
 */

/** A session row as SQLite returns it, `scope` aside. */
export interface RawSessionRow {
  readonly createdAt: unknown;
  readonly id: string;
  readonly parentMessageId: unknown;
  readonly parentSessionId: unknown;
  readonly recursionDepth: unknown;
  readonly status: unknown;
  readonly title: unknown;
  readonly updatedAt: unknown;
}

/** A message row as SQLite returns it, `scope` and `position` aside. */
export interface RawMessageRow {
  readonly createdAt: unknown;
  readonly id: string;
  readonly metadata: unknown;
  readonly parts: unknown;
  readonly role: unknown;
  readonly sessionId: string;
  readonly status: unknown;
  readonly summarized: unknown;
  readonly updatedAt: unknown;
}

/** The record a session row holds; NULL `recursion_depth` is the field left out. */
export function sessionOf(row: RawSessionRow, scope: string): SessionRecord {
  const what = `session ${JSON.stringify(row.id)} in scope ${JSON.stringify(scope)}`;
  return checked(what, () =>
    keptSession({
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
    })
  );
}

/**
 * The record a message row holds; NULL `metadata` or `summarized` is the
 * field left out. Rejects a row whose columns or JSON are not a message.
 */
export function messageOf(row: RawMessageRow, scope: string): SessionMessage {
  const what = `message ${JSON.stringify(row.id)} of session ${JSON.stringify(row.sessionId)} in scope ${JSON.stringify(scope)}`;
  const parts = parsed(row.parts, "parts", what);
  const metadata =
    row.metadata === null ? undefined : parsed(row.metadata, "metadata", what);
  const summarized = summarizedOf(row.summarized, what);
  return checked(what, () =>
    keptMessage({
      createdAt: row.createdAt,
      id: row.id,
      ...(metadata === undefined ? {} : { metadata }),
      parts,
      role: row.role,
      sessionId: row.sessionId,
      status: row.status,
      ...(summarized === undefined ? {} : { summarized }),
      updatedAt: row.updatedAt,
    })
  );
}

/** `decode()`, with a {@link RecordFault} reported against the row. */
function checked<T>(what: string, decode: () => T): T {
  try {
    return decode();
  } catch (error) {
    if (error instanceof RecordFault) {
      throw unreadable(what, `field ${error.path} ${error.reason}`, error);
    }
    throw error;
  }
}

/** `summarized` as the record holds it: 0 and 1 are false and true, NULL the field left out. */
function summarizedOf(value: unknown, what: string): boolean | undefined {
  switch (value) {
    case null:
      return undefined;
    case 0:
      return false;
    case 1:
      return true;
    default:
      throw unreadable(
        what,
        `column summarized holds ${describe(value)}, not 0, 1 or NULL`
      );
  }
}

/** A JSON column's text parsed, or a refusal naming `column` and what is wrong. */
function parsed(text: unknown, column: string, what: string): unknown {
  if (typeof text !== "string") {
    throw unreadable(
      what,
      `column ${column} holds ${describe(text)}, not JSON text`
    );
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw unreadable(
      what,
      `column ${column} holds text that is not JSON (${cause instanceof Error ? cause.message : String(cause)})`,
      cause
    );
  }
}

function describe(value: unknown): string {
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

function unreadable(what: string, fault: string, cause?: unknown): Error {
  return new Error(`SqliteSessionStore cannot read ${what}: ${fault}`, {
    cause,
  });
}
