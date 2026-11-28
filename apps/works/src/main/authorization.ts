import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Authorization } from "@foundry/authorization";
import {
  type AuthorizationDatabase,
  SqliteAuthorizationStore,
} from "@foundry/authorization/store/sqlite";
import { createClient } from "@libsql/client";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";

const AUTHORIZATION_DDL = [
  `CREATE TABLE IF NOT EXISTS "authorization_grants" (
    "action" text NOT NULL,
    "created_at" integer NOT NULL,
    "id" text NOT NULL,
    "invocation_id" text,
    "issuance_key" text,
    "position" integer NOT NULL,
    "record" text NOT NULL,
    "revision" integer NOT NULL,
    "scope" text NOT NULL,
    "session_id" text,
    "state" text NOT NULL,
    "updated_at" integer NOT NULL,
    PRIMARY KEY ("scope", "id")
  )`,
  `CREATE INDEX IF NOT EXISTS "authorization_grants_scope_position" ON "authorization_grants" ("scope", "position")`,
  `CREATE INDEX IF NOT EXISTS "authorization_grants_scope_state" ON "authorization_grants" ("scope", "state")`,
  `CREATE INDEX IF NOT EXISTS "authorization_grants_scope_state_action" ON "authorization_grants" ("scope", "state", "action")`,
  `CREATE INDEX IF NOT EXISTS "authorization_grants_scope_session" ON "authorization_grants" ("scope", "session_id")`,
  `CREATE INDEX IF NOT EXISTS "authorization_grants_scope_issuance" ON "authorization_grants" ("scope", "issuance_key")`,
  `CREATE INDEX IF NOT EXISTS "authorization_grants_scope_invocation" ON "authorization_grants" ("scope", "invocation_id")`,
  `CREATE TABLE IF NOT EXISTS "authorization_restrictions" (
    "action" text NOT NULL,
    "applies_under" text,
    "created_at" integer NOT NULL,
    "id" text NOT NULL,
    "kind" text NOT NULL,
    "position" integer NOT NULL,
    "record" text NOT NULL,
    "revision" integer NOT NULL,
    "scope" text NOT NULL,
    "updated_at" integer NOT NULL,
    PRIMARY KEY ("scope", "id")
  )`,
  `CREATE INDEX IF NOT EXISTS "authorization_restrictions_scope_position" ON "authorization_restrictions" ("scope", "position")`,
  `CREATE INDEX IF NOT EXISTS "authorization_restrictions_scope_action" ON "authorization_restrictions" ("scope", "action")`,
  `CREATE TABLE IF NOT EXISTS "authorization_claims" (
    "claimed_at" integer NOT NULL,
    "grant_id" text NOT NULL,
    "invocation_id" text NOT NULL,
    "request_fingerprint" text,
    "scope" text NOT NULL,
    PRIMARY KEY ("scope", "invocation_id")
  )`,
  `CREATE INDEX IF NOT EXISTS "authorization_claims_scope_grant" ON "authorization_claims" ("scope", "grant_id")`,
] as const;

export interface WorksAuthorization {
  readonly authorization: Authorization;
  close(): void;
  readonly database: AuthorizationDatabase;
  readonly store: SqliteAuthorizationStore;
}

async function ensureAuthorizationTables(
  database: AuthorizationDatabase
): Promise<void> {
  for (const statement of AUTHORIZATION_DDL) {
    await database.run(sql.raw(statement));
  }
}

export async function openWorksAuthorization(
  location: string,
  scope = "works"
): Promise<WorksAuthorization> {
  const url =
    location === ":memory:" || location.startsWith("file:")
      ? location
      : `file:${location}`;
  if (url.startsWith("file:")) {
    await mkdir(path.dirname(url.slice("file:".length)), {
      mode: 0o700,
      recursive: true,
    });
  }
  const client = createClient({ url });
  const database = drizzle(client);
  try {
    await ensureAuthorizationTables(database);
  } catch (error) {
    client.close();
    throw error;
  }
  const store = new SqliteAuthorizationStore({ database, scope });
  const authorization = new Authorization({ store });
  return {
    authorization,
    close() {
      client.close();
    },
    database,
    store,
  };
}
