import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

import type { MessageMetadata, SessionPart } from "../schema";
import {
  MESSAGE_STATUSES,
  SESSION_ROLES,
  SESSION_STATUSES,
} from "../session/constants";

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
