import type { SessionMessage, SessionRecord } from "../schema";
import { MESSAGE_STATUSES, SESSION_ROLES, SESSION_STATUSES } from "../schema";
import { metadataFault, partsFault } from "./message-shape";

/**
 * How `SqliteSessionStore` reads a row back as a record: the one decoder.
 * It takes each column as SQLite returns it, the JSON columns as text and
 * `summarized` as an integer, and rejects a row it would not have written,
 * naming the scope, the session, the message and the column or field at
 * fault. Without Zod: each check is the one `./message-shape` defines.
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
  const fault = sessionFault(row);
  if (fault !== undefined) {
    throw unreadable(
      `session ${JSON.stringify(row.id)} in scope ${JSON.stringify(scope)}`,
      fault
    );
  }
  return {
    createdAt: row.createdAt as number,
    id: row.id,
    parentMessageId: row.parentMessageId as string | null,
    parentSessionId: row.parentSessionId as string | null,
    ...(row.recursionDepth === null
      ? {}
      : { recursionDepth: row.recursionDepth as number }),
    status: row.status as SessionRecord["status"],
    title: row.title as string | null,
    updatedAt: row.updatedAt as number,
  };
}

/**
 * The record a message row holds; NULL `metadata` or `summarized` is the
 * field left out. Rejects a row whose columns or JSON are not a message.
 */
export function messageOf(row: RawMessageRow, scope: string): SessionMessage {
  const what = `message ${JSON.stringify(row.id)} of session ${JSON.stringify(row.sessionId)} in scope ${JSON.stringify(scope)}`;
  const fault = messageColumnsFault(row);
  if (fault !== undefined) {
    throw unreadable(what, fault);
  }
  const parts = parsed(row.parts, "parts", what);
  const metadata =
    row.metadata === null ? undefined : parsed(row.metadata, "metadata", what);
  const shape =
    partsFault(parts) ??
    (row.metadata === null ? undefined : metadataFault(metadata));
  if (shape !== undefined) {
    throw unreadable(what, `field ${shape.path} ${shape.reason}`);
  }
  return {
    createdAt: row.createdAt as number,
    id: row.id,
    ...(metadata === undefined
      ? {}
      : { metadata: metadata as SessionMessage["metadata"] & object }),
    parts: parts as SessionMessage["parts"],
    role: row.role as SessionMessage["role"],
    sessionId: row.sessionId,
    status: row.status as SessionMessage["status"],
    ...(row.summarized === null ? {} : { summarized: row.summarized === 1 }),
    updatedAt: row.updatedAt as number,
  };
}

function sessionFault(row: RawSessionRow): string | undefined {
  return (
    enumFault("status", row.status, SESSION_STATUSES, "session status") ??
    numberFault("created_at", row.createdAt) ??
    numberFault("updated_at", row.updatedAt) ??
    nullableFault("recursion_depth", row.recursionDepth, "number") ??
    nullableFault("title", row.title, "string") ??
    nullableFault("parent_session_id", row.parentSessionId, "string") ??
    nullableFault("parent_message_id", row.parentMessageId, "string")
  );
}

function messageColumnsFault(row: RawMessageRow): string | undefined {
  return (
    enumFault("role", row.role, SESSION_ROLES, "role") ??
    enumFault("status", row.status, MESSAGE_STATUSES, "message status") ??
    numberFault("created_at", row.createdAt) ??
    numberFault("updated_at", row.updatedAt) ??
    (typeof row.parts === "string"
      ? undefined
      : `column parts holds ${describe(row.parts)}, not JSON text`) ??
    nullableFault("metadata", row.metadata, "string") ??
    (row.summarized === null || row.summarized === 0 || row.summarized === 1
      ? undefined
      : `column summarized holds ${describe(row.summarized)}, not 0, 1 or NULL`)
  );
}

function enumFault(
  column: string,
  value: unknown,
  values: readonly string[],
  what: string
): string | undefined {
  return typeof value === "string" && values.includes(value)
    ? undefined
    : `column ${column} holds ${describe(value)}, which is no ${what}`;
}

function numberFault(column: string, value: unknown): string | undefined {
  return typeof value === "number"
    ? undefined
    : `column ${column} holds ${describe(value)}, not a number`;
}

function nullableFault(
  column: string,
  value: unknown,
  type: "number" | "string"
): string | undefined {
  return value === null || typeof value === type
    ? undefined
    : `column ${column} holds ${describe(value)}, not a ${type} or NULL`;
}

/** `text` parsed as JSON, or a refusal naming `column` and what is wrong. */
function parsed(text: unknown, column: string, what: string): unknown {
  try {
    return JSON.parse(text as string);
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
