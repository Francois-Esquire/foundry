import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import type { Grant, GrantId, Restriction, RestrictionId } from "../schema";
import { GRANT_STATES, RESTRICTION_KINDS } from "../schema";

export const authorizationGrants = sqliteTable(
  "authorization_grants",
  {
    action: text("action").notNull(),
    createdAt: integer("created_at").notNull(),
    id: text("id").$type<GrantId>().notNull(),
    invocationId: text("invocation_id"),
    issuanceKey: text("issuance_key"),
    position: integer("position").notNull(),
    record: text("record", { mode: "json" }).$type<Grant>().notNull(),
    revision: integer("revision").notNull(),
    scope: text("scope").notNull(),
    sessionId: text("session_id"),
    state: text("state", { enum: GRANT_STATES }).notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.id] }),
    index("authorization_grants_scope_position").on(
      table.scope,
      table.position
    ),
    index("authorization_grants_scope_state").on(table.scope, table.state),
    index("authorization_grants_scope_session").on(
      table.scope,
      table.sessionId
    ),
    index("authorization_grants_scope_issuance").on(
      table.scope,
      table.issuanceKey
    ),
    index("authorization_grants_scope_invocation").on(
      table.scope,
      table.invocationId
    ),
  ]
);

export const authorizationRestrictions = sqliteTable(
  "authorization_restrictions",
  {
    action: text("action").notNull(),
    appliesUnder: text("applies_under").$type<GrantId>(),
    createdAt: integer("created_at").notNull(),
    id: text("id").$type<RestrictionId>().notNull(),
    kind: text("kind", { enum: RESTRICTION_KINDS }).notNull(),
    position: integer("position").notNull(),
    record: text("record", { mode: "json" }).$type<Restriction>().notNull(),
    revision: integer("revision").notNull(),
    scope: text("scope").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.id] }),
    index("authorization_restrictions_scope_position").on(
      table.scope,
      table.position
    ),
  ]
);

export const authorizationClaims = sqliteTable(
  "authorization_claims",
  {
    claimedAt: integer("claimed_at").notNull(),
    grantId: text("grant_id").$type<GrantId>().notNull(),
    invocationId: text("invocation_id").notNull(),
    releasedAt: integer("released_at"),
    scope: text("scope").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.invocationId] }),
    index("authorization_claims_scope_grant").on(table.scope, table.grantId),
  ]
);
