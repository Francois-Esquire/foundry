import type { ModuleProjectIdentity } from "./compose";

import { formatJson } from "./json";

export const PACKAGE_MANAGER = "bun@1.1.42";

export const WORKSPACE_SCRIPTS: Readonly<Record<string, string>> = {
  build: "turbo run build",
  check: "turbo run typecheck lint format",
  dev: "turbo run dev",
  format: "turbo run format",
  "format:fix": "turbo run format:fix",
  generate: "turbo run generate",
  lint: "turbo run lint",
  "lint:fix": "turbo run lint:fix",
  start: "NODE_ENV=production bun packages/server/dist/index.js",
  typecheck: "turbo run typecheck",
  validate: "bun run format:fix && bun run check && bun run build",
};

/** Composition additionally lists the local `@foundry/module-sdk` first. */
export const ROOT_DEV_DEPENDENCIES: Readonly<Record<string, string>> = {
  "@eslint/js": "^10.0.1",
  "@types/bun": "1.3.14",
  "@types/react": "19.2.17",
  "@types/react-dom": "19.2.3",
  eslint: "^10.7.0",
  prettier: "^3.9.4",
  turbo: "^2.10.3",
  typescript: "^6.0.3",
  "typescript-eslint": "^8.62.1",
};

const PACKAGE_CHECK_SCRIPTS = {
  format: "prettier --check . --ignore-path ../../.prettierignore",
  "format:fix": "prettier --write . --ignore-path ../../.prettierignore",
  lint: "eslint src",
  "lint:fix": "eslint src --fix",
  typecheck: "tsc --noEmit -p tsconfig.json",
} as const;

export const APP_PACKAGE_SCRIPTS: Readonly<Record<string, string>> = {
  build: "bunx vite build",
  dev: "bunx vite --host 0.0.0.0",
  generate: "bunx graphql-codegen --config codegen.ts",
  ...PACKAGE_CHECK_SCRIPTS,
};

/** Composition additionally lists the local `@foundry/module-sdk` first. */
export const APP_DEPENDENCIES: Readonly<Record<string, string>> = {
  "@graphql-typed-document-node/core": "3.2.0",
};

export const APP_DEV_DEPENDENCIES: Readonly<Record<string, string>> = {
  "@graphql-codegen/cli": "7.2.0",
  "@graphql-codegen/client-preset": "6.1.2",
  "@module/server": "workspace:*",
  graphql: "16.11.0",
};

export const BUN_BUILD_SCRIPT =
  "bun build src/index.ts --outdir dist --target bun";

const SERVER_BUILD_SCRIPT = `${BUN_BUILD_SCRIPT} && rm -rf dist/drizzle && cp -R ../database/drizzle dist/drizzle`;

export const SERVER_PACKAGE_SCRIPTS: Readonly<Record<string, string>> = {
  build: SERVER_BUILD_SCRIPT,
  dev: "bun --watch src/index.ts",
  generate: "bun scripts/generate-schema.ts",
  ...PACKAGE_CHECK_SCRIPTS,
};

export const DATABASE_PACKAGE_SCRIPTS: Readonly<Record<string, string>> = {
  build: BUN_BUILD_SCRIPT,
  ...PACKAGE_CHECK_SCRIPTS,
};

export function moduleProjectReadme(project: ModuleProjectIdentity): string {
  return `# ${project.displayName}

This is a standard Bun, React, Vite, and Turbo workspace. The root only
orchestrates package scripts; package source and build output stay with the
package that owns them.

## Packages

- \`packages/app\`: React and Vite application. Vite proxies \`/_module\` and
  \`/_foundry\` to the server during development.
- \`packages/server\`: Bun program and Module HTTP boundary. It imports the
  database and the Module SDK through workspace dependencies.
- \`packages/database\`: Drizzle schema, migrations, and SQLite ownership.
- \`packages/module-sdk\`: the release-pinned Module SDK supplied by the host.

The supported flow is \`app -> server -> database\`. The app's
\`src/module-api.ts\` is the default request seam. Do not import database code
into the app or move generated output to the workspace root.

## Commands

- \`bun run dev\`: run every required package development process through Turbo.
- \`bun run build\`: ask each buildable package to produce its own \`dist\`.
- \`bun run typecheck\`, \`bun run lint\`, and \`bun run format\`: run the
  corresponding package checks.
- \`bun run validate\`: format source, run checks, and build. Tests are
  intentionally separate.

## Release output

Each package owns \`packages/<name>/dist/**\`. The host preserves those paths
unchanged in the Release and starts the program entry declared by
\`foundry.module.json\`. There is no root generation directory or implicit
cross-package output remapping.
`;
}

export const PRETTIER_IGNORE_SOURCE = `.tmp/
.turbo/
node_modules/
**/dist/
packages/*/generated/
packages/module-sdk/
bun.lock
*.sqlite*
`;

export const TURBO_CONFIGURATION_SOURCE = formatJson({
  $schema: "https://turbo.build/schema.json",
  globalEnv: [
    "FOUNDRY_FILES_PATH",
    "FOUNDRY_MODULE_CATALOG_PATH",
    "FOUNDRY_MODULE_DATA_PATH",
    "PORT",
    "VITE_PORT",
  ],
  tasks: {
    build: { dependsOn: ["generate", "^build"], outputs: ["dist/**"] },
    dev: { cache: false, dependsOn: ["generate"], persistent: true },
    format: { outputs: [] },
    "format:fix": { cache: false, outputs: [] },
    generate: { dependsOn: ["^generate"], outputs: ["generated/**"] },
    lint: { outputs: [] },
    "lint:fix": { cache: false, outputs: [] },
    typecheck: { dependsOn: ["generate"], outputs: [] },
  },
  ui: "stream",
});

export const ESLINT_CONFIGURATION_SOURCE = `import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/.tmp/**",
      "**/.turbo/**",
      "**/dist/**",
      "**/generated/**",
      "**/node_modules/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
);
`;

export const MODULE_VITE_CONFIGURATION_SOURCE =
  `import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const program = ` +
  // biome-ignore lint/suspicious/noTemplateCurlyInString: emits a template literal into the generated vite.config.ts
  '`http://127.0.0.1:${process.env.PORT ?? "3000"}`' +
  `;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    port: Number(process.env.VITE_PORT ?? 5173),
    strictPort: true,
    proxy: {
      "/_foundry": { target: program, ws: true },
      "/_module": { target: program, ws: true },
    },
  },
});
`;

export const DEVELOPMENT_DATABASE_IMPORTS = `import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Database } from "bun:sqlite";`;

export const LEGACY_DATABASE_PATH_SOURCE =
  'const path = process.env.FOUNDRY_MODULE_DATA_PATH ?? "/foundry/data/data.sqlite";';

export const DEVELOPMENT_DATABASE_PATH_SOURCE = `const configuredPath =
  process.env.FOUNDRY_MODULE_DATA_PATH;
const path =
  configuredPath ??
  fileURLToPath(new URL("../.data/data.sqlite", import.meta.url));
mkdirSync(dirname(path), { recursive: true });`;

const DATABASE_RECOVERY_SOURCE = `let client: Database;
try {
  client = openDatabase();
} catch (error) {
  const corrupt =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "SQLITE_CORRUPT";
  if (configuredPath !== undefined || !corrupt) throw error;
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(path + suffix, { force: true });
  }
  client = openDatabase();
}
`;

/** What composer 12 wrote before Programs owned their migrations. */
export const INLINE_SCHEMA_DATABASE_INDEX_SOURCE = `${DEVELOPMENT_DATABASE_IMPORTS}
import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "./schema";

${DEVELOPMENT_DATABASE_PATH_SOURCE}
function openDatabase(): Database {
  const client = new Database(path);
  client.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)");
  return client;
}

${DATABASE_RECOVERY_SOURCE}
export const db = drizzle({ client, schema });
`;

export const DATABASE_INDEX_SOURCE = `import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import * as schema from "./schema";

// The host mounts the Installation's files directory. Hosts older than that
// directory handed over the database path itself.
const filesPath = process.env.FOUNDRY_FILES_PATH;
const configuredPath =
  filesPath === undefined
    ? process.env.FOUNDRY_MODULE_DATA_PATH
    : join(filesPath, "data.sqlite");
const path =
  configuredPath ??
  fileURLToPath(new URL("../.data/data.sqlite", import.meta.url));
mkdirSync(dirname(path), { recursive: true });

// Copied beside the built Program; beside this source during development.
const migrationsFolder = ["./drizzle", "../drizzle"]
  .map((candidate) => fileURLToPath(new URL(candidate, import.meta.url)))
  .find((candidate) => existsSync(candidate));
if (migrationsFolder === undefined) {
  throw new Error("Module database migrations are missing");
}

function openDatabase(): Database {
  const client = new Database(path);
  client.exec("PRAGMA journal_mode=WAL");
  return client;
}

${DATABASE_RECOVERY_SOURCE}
export const db = drizzle({ client, schema });

// Importing this package migrates, so the Program never listens, and the host
// never sees it ready, on a database older than its code.
migrate(db, { migrationsFolder });
`;

export const INLINE_SCHEMA_NOTES_MIGRATION_SOURCE = `CREATE TABLE \`notes\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`body\` text NOT NULL
);
`;

// `IF NOT EXISTS`: databases created by the inline schema already hold the
// table but no migration journal.
export const NOTES_MIGRATION_SOURCE = `CREATE TABLE IF NOT EXISTS \`notes\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`body\` text NOT NULL
);
`;

export const DATABASE_PACKAGE_FILES: Readonly<Record<string, string>> = {
  "packages/database/drizzle/0000_notes.sql": NOTES_MIGRATION_SOURCE,
  "packages/database/drizzle/meta/_journal.json": formatJson({
    dialect: "sqlite",
    entries: [
      {
        breakpoints: true,
        idx: 0,
        tag: "0000_notes",
        version: "6",
        when: 0,
      },
    ],
    version: "7",
  }),
  "packages/database/package.json": formatJson({
    dependencies: { "drizzle-orm": "0.45.2" },
    exports: {
      ".": "./src/index.ts",
      // Build-time consumers take the schema without opening the Data Space.
      "./build": "./src/build.ts",
    },
    name: "@module/database",
    private: true,
    scripts: DATABASE_PACKAGE_SCRIPTS,
    type: "module",
  }),
  "packages/database/src/build.ts": `import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "./schema";

/**
 * A Drizzle instance carrying the schema and no Data Space, for tooling that
 * derives artifacts from the table definitions. The Release build runs before
 * any Installation exists, so it has no database file to open.
 */
export function createSchemaOnlyDatabase() {
  return drizzle({ client: new Database(":memory:"), schema });
}
`,
  "packages/database/src/index.ts": DATABASE_INDEX_SOURCE,
  "packages/database/src/schema.ts": `import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const notes = sqliteTable("notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  body: text("body").notNull(),
});
`,
};

export const PROGRAM_STATIC_IMPORTS = `import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";`;

export const PROGRAM_STATIC_CONFIGURATION = `const appRoot = resolve(
  process.env.FOUNDRY_MODULE_APP_PATH ??
    fileURLToPath(new URL("../../app/dist", import.meta.url)),
);
// Bracket lookup: bun build inlines dot-access NODE_ENV at bundle time, which
// would freeze the built Program in development mode.
const developmentAppOrigin =
  process.env["NODE_ENV"] === "production"
    ? undefined
    : "http://127.0.0.1:" + (process.env.VITE_PORT ?? "5173");

async function serveApplication(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (developmentAppOrigin !== undefined) {
    const target = new URL(url.pathname + url.search, developmentAppOrigin);
    try {
      return await fetch(target, {
        method: request.method,
        headers: request.headers,
        body:
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : await request.arrayBuffer(),
        redirect: "manual",
      });
    } catch {
      return new Response("Vite development server is not ready", {
        status: 503,
      });
    }
  }
  let relative: string;
  try {
    relative =
      decodeURIComponent(url.pathname).replace(/^\\/+/, "") || "index.html";
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const requested = resolve(appRoot, relative);
  if (requested !== appRoot && !requested.startsWith(appRoot + sep)) {
    return new Response("Not found", { status: 404 });
  }
  const file = Bun.file(requested);
  if (await file.exists()) return new Response(file);
  if (relative.includes(".")) return new Response("Not found", { status: 404 });
  const fallback = Bun.file(resolve(appRoot, "index.html"));
  return (await fallback.exists())
    ? new Response(fallback)
    : new Response("Module application has not been built", { status: 503 });
}`;

export const PROGRAM_GATEWAY_HEARTBEAT_SOURCE = `        if (
          typeof frame === "object" && frame !== null &&
          "kind" in frame && frame.kind === "heartbeat" &&
          gatewayModes.has(socket)
        ) {
          socket.send(JSON.stringify({
            kind: "heartbeat",
            sequence: (frame as { sequence?: unknown }).sequence,
          }));
          return;
        }`;

export const GENERATE_SCHEMA_SOURCE = `import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { buildSchema } from "drizzle-graphql";
import { printSchema } from "graphql";

import { createSchemaOnlyDatabase } from "@module/database/build";

const output = "generated/schema.graphql";
await mkdir(dirname(output), { recursive: true });
await writeFile(
  output,
  printSchema(buildSchema(createSchemaOnlyDatabase()).schema),
);
`;

export const SERVER_PACKAGE_FILES: Readonly<Record<string, string>> = {
  "packages/server/package.json": formatJson({
    dependencies: {
      "@foundry/module-sdk": "workspace:*",
      "@module/database": "workspace:*",
      "drizzle-graphql": "0.8.5",
      graphql: "16.11.0",
      "graphql-yoga": "5.21.2",
    },
    name: "@module/server",
    private: true,
    scripts: SERVER_PACKAGE_SCRIPTS,
    type: "module",
  }),
  "packages/server/scripts/generate-schema.ts": GENERATE_SCHEMA_SOURCE,
  "packages/server/src/index.ts": `${PROGRAM_STATIC_IMPORTS}

import { buildSchema } from "drizzle-graphql";
import { createYoga } from "graphql-yoga";
import type { Plugin } from "graphql-yoga";
import {
  NoSchemaIntrospectionCustomRule,
  specifiedRules,
  validate,
} from "graphql";

import { db } from "@module/database";

${PROGRAM_STATIC_CONFIGURATION}

const port = Number(process.env.PORT ?? 3000);
const productionPlugins =
  process.env["NODE_ENV"] === "production"
    ? [{
        onValidate({ params, setResult }) {
          const errors = validate(params.schema, params.documentAST, [
            ...specifiedRules,
            NoSchemaIntrospectionCustomRule,
          ]);
          if (errors.length > 0) setResult(errors);
        },
      } satisfies Plugin]
    : [];
const yoga = createYoga({
  schema: buildSchema(db).schema,
  graphqlEndpoint: "/_module/graphql",
  graphiql: false,
  landingPage: false,
  plugins: productionPlugins,
});

const gatewayModes = new WeakMap<object, "development" | "runtime">();

Bun.serve({
  port,
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/_foundry/module-gateway" && server.upgrade(request)) return;
    if (url.pathname === "/_foundry/health") return Response.json({ status: "ready" });
    if (url.pathname.startsWith("/_foundry/")) return new Response("Not found", { status: 404 });
    if (url.pathname.startsWith("/_module/")) return yoga.fetch(request);
    return serveApplication(request);
  },
  websocket: {
    message(socket, message) {
      if (typeof message !== "string") {
        socket.close(1003, "Gateway accepts JSON text frames");
        return;
      }
      try {
        const frame: unknown = JSON.parse(message);
${PROGRAM_GATEWAY_HEARTBEAT_SOURCE}
        if (
          typeof frame !== "object" ||
          frame === null ||
          Array.isArray(frame) ||
          (frame as { kind?: unknown }).kind !== "hello" ||
          (frame as { protocol?: unknown }).protocol !== 1 ||
          ((frame as { mode?: unknown }).mode !== "development" &&
            (frame as { mode?: unknown }).mode !== "runtime")
        ) {
          socket.close(1002, "Gateway hello is invalid");
          return;
        }
        const mode = (frame as { readonly mode: "development" | "runtime" }).mode;
        gatewayModes.set(socket, mode);
        socket.send(JSON.stringify({ kind: "ready", protocol: 1, mode }));
      } catch {
        socket.close(1007, "Gateway frame is not JSON");
      }
    },
    close(socket) { gatewayModes.delete(socket); },
  },
});
`,
};

export const MODULE_CLIENT_SOURCE = `export {
  CreateModuleNoteDocument,
  ModuleHealthDocument,
  ModuleNotesDocument,
} from "../generated/client/graphql";
`;

/** What earlier composers wrote, importing a root output that upgrades prune. */
export const LEGACY_MODULE_CLIENT_SOURCE = `export {
  CreateModuleNoteDocument,
  ModuleHealthDocument,
  ModuleNotesDocument,
} from "../../../.foundry/generated/client/graphql";
`;

export const PACKAGE_WIRING_FILES: Readonly<Record<string, string>> = {
  "packages/app/codegen.ts": `import type { CodegenConfig } from "@graphql-codegen/cli";

const config: CodegenConfig = {
  schema: "../server/generated/schema.graphql",
  documents: ["src/**/*.{ts,tsx,graphql}"],
  generates: {
    "generated/client/": { preset: "client", plugins: [] },
  },
};

export default config;
`,
  "packages/app/src/module-api.ts": `interface ModuleResponse<Data> {
  readonly data?: Data;
  readonly errors?: readonly { readonly message: string }[];
}

export async function requestModule<Data>(
  query: string,
  variables?: Readonly<Record<string, unknown>>,
): Promise<Data> {
  const response = await fetch("/_module/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const result = (await response.json()) as ModuleResponse<Data>;
  if (!response.ok || result.data === undefined || result.errors !== undefined) {
    throw new Error(
      result.errors?.map((error) => error.message).join("; ") ??
        \`Module request failed with status \${response.status}\`,
    );
  }
  return result.data;
}
`,
  "packages/app/src/module-client.ts": MODULE_CLIENT_SOURCE,
  "packages/app/src/module.graphql": `query ModuleHealth { __typename }

mutation CreateModuleNote($values: NotesInsertInput!) {
  insertIntoNotesSingle(values: $values) {
    id
    body
  }
}

query ModuleNotes {
  notes {
    id
    body
  }
}
`,
  "packages/app/tsconfig.json": formatJson({
    compilerOptions: { types: ["vite/client", "react", "react-dom"] },
    extends: "../../tsconfig.json",
    include: ["src", "generated", "vite.config.ts"],
  }),
  "packages/database/tsconfig.json": formatJson({
    compilerOptions: { types: ["bun"] },
    extends: "../../tsconfig.json",
    include: ["src"],
  }),
  "packages/server/tsconfig.json": formatJson({
    compilerOptions: { types: ["bun"] },
    extends: "../../tsconfig.json",
    include: ["src"],
  }),
};
