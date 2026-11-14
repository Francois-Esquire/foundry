import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

import type { MessageMetadata, SessionPart } from "../schema";
import { MESSAGE_STATUSES, SESSION_ROLES, SESSION_STATUSES } from "../schema";

/**
 * The tables `SqliteSessionStore` reads and writes, for a host to compose
 * into its own schema and migrations. Each holds the matching record from
 * `@foundry/agents/schema` field for field, as the record holds it: epoch
 * milliseconds and counts are integers, a message's `parts` and `metadata`
 * are JSON text. Every table also has `scope`, an opaque partition key the
 * host chooses, first in every key.
 *
 * A column that may be NULL is an optional field: NULL is the field left out
 * (`recursionDepth`, `metadata`, `summarized`), or `null` where the record
 * takes `null` (`title`, `parentSessionId`, `parentMessageId`).
 */

/**
 * One row per `SessionRecord`. The primary key serves `getSession`; no read
 * lists sessions, so there is no other index.
 */
export const agentSessions = sqliteTable(
  "agent_sessions",
  {
    createdAt: integer("created_at").notNull(),
    id: text("id").notNull(),
    parentMessageId: text("parent_message_id"),
    parentSessionId: text("parent_session_id"),
    recursionDepth: integer("recursion_depth"),
    scope: text("scope").notNull(),
    status: text("status", { enum: SESSION_STATUSES }).notNull(),
    title: text("title"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope, table.id] })]
);

/**
 * One row per `SessionMessage`, plus `position`: its place in its session.
 * A message new to a session takes the next position there, one put again
 * in its session keeps its own, and one moved to another session takes the
 * next position in that session.
 *
 * - The primary key is `(scope, id)`: a message id names one message in a
 *   scope, whatever its session, as `getMessage(id)` reads it and a put
 *   under another session moves it. It serves `getMessage` and the commit's
 *   lookup of where each message it puts is filed now.
 * - `agent_messages_scope_session_position` serves `listMessages`, which
 *   reads one session's run of it in order, and the commit's next position
 *   in a session, which reads the last entry of that run. Neither scans the
 *   other sessions or sorts.
 */
export const agentMessages = sqliteTable(
  "agent_messages",
  {
    createdAt: integer("created_at").notNull(),
    id: text("id").notNull(),
    metadata: text("metadata", { mode: "json" }).$type<MessageMetadata>(),
    parts: text("parts", { mode: "json" }).$type<SessionPart[]>().notNull(),
    position: integer("position").notNull(),
    role: text("role", { enum: SESSION_ROLES }).notNull(),
    scope: text("scope").notNull(),
    sessionId: text("session_id").notNull(),
    status: text("status", { enum: MESSAGE_STATUSES }).notNull(),
    summarized: integer("summarized", { mode: "boolean" }),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.id] }),
    index("agent_messages_scope_session_position").on(
      table.scope,
      table.sessionId,
      table.position
    ),
  ]
);
