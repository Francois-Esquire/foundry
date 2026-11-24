import { RecordFault } from "@foundry/lib/sqlite";
import type { SessionMessage, SessionRecord } from "../schema";
import { keptMessage, keptSession } from "./sqlite-records";

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
