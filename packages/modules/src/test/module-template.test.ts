import { describe, expect, it } from "vitest";

import { parseModuleManifestSourceText } from "../manifest";
import { buildModuleSdkPack } from "../sdk";
import { MODULE_SDK_GENERATOR_ENTRYPOINT } from "../sdk/generator-source";
import { MODULE_SDK_ENTRYPOINT } from "../sdk/source";
import {
  composeModuleTemplate,
  type ModuleBase,
  ModuleTemplateCompositionError,
  moduleTemplateBaseIssue,
} from "../template/compose";
import { upgradeModuleWorkspaceSource } from "../template/upgrade";
import { reactModuleBase } from "./helpers/module-base";

/** A Bun API application: no `build` script and no `packages/app` React source. */
const BUN_API_PACKAGE = `${JSON.stringify(
  { name: "bun-api", scripts: { start: "bun run index.ts" } },
  null,
  2
)}`;
const BUN_API_INDEX = `const server = Bun.serve({
  port: 3111,
  hostname: "0.0.0.0",
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/") return Response.json({ hello: "bun", runtime: Bun.version })
    if (url.pathname === "/health") return Response.json({ status: "ok" })
    return new Response("Not Found", { status: 404 })
  },
})
console.log(\`Listening on \${server.url}\`)`;
const bunApiBase: ModuleBase = {
  files: { "index.ts": BUN_API_INDEX, "package.json": BUN_API_PACKAGE },
  id: "bun-api",
  name: "Bun API",
};

const project = {
  displayName: "Weather Module",
  id: "weather-module",
  packageName: "weather-module",
} as const;

const DATABASE_INDEX_PATH = "packages/database/src/index.ts";
const NOTES_MIGRATION_PATH = "packages/database/drizzle/0000_notes.sql";

/** Verbatim composer-12 output, as it sits in existing workspaces. */
const INLINE_SCHEMA_DATABASE_INDEX = `import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "./schema";

const configuredPath =
  process.env.FOUNDRY_MODULE_DATA_PATH;
const path =
  configuredPath ??
  fileURLToPath(new URL("../.data/data.sqlite", import.meta.url));
mkdirSync(dirname(path), { recursive: true });
function openDatabase(): Database {
  const client = new Database(path);
  client.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)");
  return client;
}

let client: Database;
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

export const db = drizzle({ client, schema });
`;
const INLINE_SCHEMA_NOTES_MIGRATION = `CREATE TABLE \`notes\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`body\` text NOT NULL
);
`;

describe("Module template base eligibility", () => {
  it.each<{
    readonly name: string;
    readonly files: Readonly<Record<string, string>>;
    readonly issue: string;
  }>([
    {
      files: { "src/App.tsx": "export {};" },
      issue: "Module base bun-react does not contain package.json",
      name: "a missing package.json",
    },
    {
      files: { "package.json": "{ not json" },
      issue: "Module base bun-react has an invalid package.json",
      name: "package.json that is not JSON",
    },
    {
      files: { "package.json": "[]" },
      issue: "Module base bun-react has an invalid package.json",
      name: "package.json that is not an object",
    },
    {
      files: { "package.json": JSON.stringify({ scripts: { dev: "vite" } }) },
      issue:
        "Module base bun-react does not provide an application build command",
      name: "no build script",
    },
    {
      files: { "package.json": JSON.stringify({ scripts: { build: "  " } }) },
      issue:
        "Module base bun-react does not provide an application build command",
      name: "a blank build script",
    },
    {
      files: {
        "package.json": JSON.stringify({
          scripts: { build: "vite build" },
          workspaces: ["packages/*"],
        }),
      },
      issue: "Module base bun-react declares workspaces the composer owns",
      name: "workspaces",
    },
    {
      files: {
        ...reactModuleBase.files,
        "packages/module-sdk/src/index.ts": "export {};",
      },
      issue:
        'Module base bun-react declares reserved Module composer path "packages/module-sdk/src/index.ts"',
      name: "a reserved composer path",
    },
  ])(
    "rejects a base with $name, as composition does",
    async ({ files, issue }) => {
      const base: ModuleBase = { ...reactModuleBase, files };
      expect(moduleTemplateBaseIssue(base)).toBe(issue);
      await expect(
        composeModuleTemplate({
          base,
          project,
          sdk: await buildModuleSdkPack(),
        })
      ).rejects.toThrow(issue);
    }
  );

  it("accepts a React application base", () => {
    expect(moduleTemplateBaseIssue(reactModuleBase)).toBeNull();
  });
});

describe("Module template composer", () => {
  it("composes the React application base without mutating it", async () => {
    const before = JSON.stringify(reactModuleBase);
    const sdk = await buildModuleSdkPack();
    const composed = await composeModuleTemplate({
      base: reactModuleBase,
      project,
      sdk,
    });

    expect(JSON.stringify(reactModuleBase)).toBe(before);
    expect(composed.files["packages/app/src/App.tsx"]).toBe(
      reactModuleBase.files["src/App.tsx"]
    );
    expect(composed.files["packages/module-sdk/src/index.ts"]).toContain(
      "createGatewayClient"
    );
    expect(composed.files["bun.lock"]).toBeUndefined();
    expect(
      Object.keys(composed.files).some(
        (path) => path === "bun.lock" || path.endsWith("/bun.lock")
      )
    ).toBe(false);
    const manifestSource = composed.files["foundry.module.json"];
    expect(manifestSource).toBeDefined();
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Record keys may be absent at runtime.
    if (manifestSource === undefined) {
      throw new Error(
        "Composed Module template must include foundry.module.json"
      );
    }
    expect(() => parseModuleManifestSourceText(manifestSource)).not.toThrow();
    expect(composed.files["packages/server/src/index.ts"]).toContain(
      "/_foundry/module-gateway"
    );
    expect(
      composed.files["packages/server/scripts/generate-schema.ts"]
    ).toContain("generated/schema.graphql");
    expect(composed.files["packages/app/codegen.ts"]).toContain(
      "../server/generated/schema.graphql"
    );
    expect(composed.files["package.json"]).toContain(
      '"generate": "turbo run generate"'
    );
    expect(composed.files["package.json"]).not.toContain("@parcel/watcher");
    expect(composed.files["package.json"]).toContain(
      '"build": "turbo run build"'
    );
    expect(composed.files["package.json"]).toContain(
      '"validate": "bun run format:fix && bun run check && bun run build"'
    );
    expect(composed.files["package.json"]).toContain(
      '"@types/react": "19.2.17"'
    );
    expect(composed.files["tsconfig.json"]).toContain('"jsx": "react-jsx"');
    expect(composed.files["packages/app/package.json"]).toContain(
      '"dev": "bunx vite --host 0.0.0.0"'
    );
    expect(composed.files["packages/app/package.json"]).toContain(
      '"build": "bunx vite build"'
    );
    expect(composed.files["packages/app/vite.config.ts"]).toContain(
      '"/_module": { target: program, ws: true }'
    );
    expect(composed.files["turbo.json"]).toContain('"persistent": true');
    expect(composed.files["turbo.json"]).toContain(
      '"FOUNDRY_MODULE_DATA_PATH"'
    );
    expect(composed.files["eslint.config.js"]).toContain('"**/.tmp/**"');
    expect(composed.files[".prettierignore"]).toContain(".tmp/");
    expect(composed.files[".foundry/scripts/watch-build.ts"]).toBeUndefined();
    expect(composed.files["packages/server/scripts/watch.ts"]).toBeUndefined();
    expect(composed.files["packages/server/package.json"]).toContain(
      '"dev": "bun --watch src/index.ts"'
    );
    expect(composed.files["packages/database/src/index.ts"]).toContain(
      "mkdirSync(dirname(path), { recursive: true })"
    );
    expect(composed.files["packages/server/src/index.ts"]).toContain(
      "return serveApplication(request)"
    );
    expect(Object.isFrozen(composed.files)).toBe(true);
  });

  it("repairs required Turbo wiring after a current workspace drifts", async () => {
    const composed = await composeModuleTemplate({
      base: reactModuleBase,
      project,
      sdk: await buildModuleSdkPack(),
    });
    const drifted = {
      ...composed.files,
      "turbo.json": `${JSON.stringify(
        {
          $schema: "https://turbo.build/schema.json",
          tasks: {
            build: { dependsOn: ["^build"], outputs: ["dist/**"] },
            custom: { cache: false },
            dev: { cache: false, persistent: true },
          },
          ui: "stream",
        },
        null,
        2
      )}\n`,
    };

    const upgraded = upgradeModuleWorkspaceSource(drifted);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Record keys may be absent at runtime.
    const turbo = JSON.parse(upgraded["turbo.json"] ?? "{}") as {
      globalEnv?: string[];
      tasks?: Record<string, { dependsOn?: string[]; cache?: boolean }>;
    };
    expect(turbo.tasks?.generate).toBeDefined();
    expect(turbo.tasks?.build?.dependsOn).toEqual(["generate", "^build"]);
    expect(turbo.tasks?.typecheck).toBeDefined();
    expect(turbo.tasks?.custom).toEqual({ cache: false });
    expect(turbo.globalEnv).toContain("FOUNDRY_MODULE_DATA_PATH");
    expect(turbo.globalEnv).toContain("FOUNDRY_FILES_PATH");
    expect(upgradeModuleWorkspaceSource(upgraded)).toBe(upgraded);
  });

  it("keeps authored GraphQL documents and client across upgrades", async () => {
    const composed = await composeModuleTemplate({
      base: reactModuleBase,
      project,
      sdk: await buildModuleSdkPack(),
    });
    const documentsPath = "packages/app/src/module.graphql";
    const clientPath = "packages/app/src/module-client.ts";
    const documents = `${composed.files[documentsPath] ?? ""}\nquery Authored { __typename }\n`;
    const client = `${composed.files[clientPath] ?? ""}export const authored = true;\n`;

    const upgraded = upgradeModuleWorkspaceSource({
      ...composed.files,
      [documentsPath]: documents,
      [clientPath]: client,
    });

    expect(upgraded[documentsPath]).toBe(documents);
    expect(upgraded[clientPath]).toBe(client);

    // Earlier composers imported a root output that upgrades prune.
    const legacy = upgradeModuleWorkspaceSource({
      ...composed.files,
      [clientPath]: (composed.files[clientPath] ?? "").replace(
        '"../generated/client/graphql"',
        '"../../../.foundry/generated/client/graphql"'
      ),
    });
    expect(legacy[clientPath]).toBe(composed.files[clientPath]);
  });

  it("composes a Program that migrates its own database inside the files directory", async () => {
    const composed = await composeModuleTemplate({
      base: reactModuleBase,
      project,
      sdk: await buildModuleSdkPack(),
    });
    const database = composed.files[DATABASE_INDEX_PATH] ?? "";
    expect(database).toContain("process.env.FOUNDRY_FILES_PATH");
    // Hosts that predate the files directory still set only this name.
    expect(database).toContain("process.env.FOUNDRY_MODULE_DATA_PATH");
    expect(database).toContain(
      'import { migrate } from "drizzle-orm/bun-sqlite/migrator";'
    );
    expect(database).toContain("migrate(db, { migrationsFolder });");
    expect(database).not.toContain("CREATE TABLE");
    // Databases the inline schema created hold the table but no journal.
    expect(composed.files[NOTES_MIGRATION_PATH]).toContain(
      "CREATE TABLE IF NOT EXISTS `notes`"
    );
    expect(
      composed.files["packages/database/drizzle/meta/_journal.json"]
    ).toBeDefined();
    const server = JSON.parse(
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Record keys may be absent at runtime.
      composed.files["packages/server/package.json"] ?? "{}"
    ) as { scripts?: Record<string, string> };
    // Only `packages/*/dist/**` becomes runnable output.
    expect(server.scripts?.build).toBe(
      "bun build src/index.ts --outdir dist --target bun && rm -rf dist/drizzle && cp -R ../database/drizzle dist/drizzle"
    );
    const upgraded = upgradeModuleWorkspaceSource(composed.files);
    expect(upgraded[DATABASE_INDEX_PATH]).toBe(database);
    expect(upgraded[NOTES_MIGRATION_PATH]).toBe(
      composed.files[NOTES_MIGRATION_PATH]
    );
    expect(upgraded["packages/server/package.json"]).toBe(
      composed.files["packages/server/package.json"]
    );
  });

  it("upgrades a byte-identical inline-schema database package and leaves an authored one alone", async () => {
    const composed = await composeModuleTemplate({
      base: reactModuleBase,
      project,
      sdk: await buildModuleSdkPack(),
    });
    const previous = {
      ...composed.files,
      [DATABASE_INDEX_PATH]: INLINE_SCHEMA_DATABASE_INDEX,
      [NOTES_MIGRATION_PATH]: INLINE_SCHEMA_NOTES_MIGRATION,
    };

    const upgraded = upgradeModuleWorkspaceSource(previous);
    expect(upgraded[DATABASE_INDEX_PATH]).toBe(
      composed.files[DATABASE_INDEX_PATH]
    );
    expect(upgraded[NOTES_MIGRATION_PATH]).toBe(
      composed.files[NOTES_MIGRATION_PATH]
    );
    expect(upgradeModuleWorkspaceSource(upgraded)).toBe(upgraded);

    const authoredIndex = `${INLINE_SCHEMA_DATABASE_INDEX}\nexport const authored = true;\n`;
    const authored = upgradeModuleWorkspaceSource({
      ...previous,
      [DATABASE_INDEX_PATH]: authoredIndex,
    });
    expect(authored[DATABASE_INDEX_PATH]).toBe(authoredIndex);
    expect(authored[NOTES_MIGRATION_PATH]).toBe(INLINE_SCHEMA_NOTES_MIGRATION);

    // A migrator against an authored first migration would fail on databases
    // that already hold the table, so both files move together or not at all.
    const authoredMigration = INLINE_SCHEMA_NOTES_MIGRATION.replace(
      "`body` text NOT NULL",
      "`body` text NOT NULL,\n  `pinned` integer"
    );
    const keptIndex = upgradeModuleWorkspaceSource({
      ...previous,
      [NOTES_MIGRATION_PATH]: authoredMigration,
    });
    expect(keptIndex[DATABASE_INDEX_PATH]).toBe(INLINE_SCHEMA_DATABASE_INDEX);
    expect(keptIndex[NOTES_MIGRATION_PATH]).toBe(authoredMigration);
  });

  it("copies migrations into the server build only when the workspace has a journal", async () => {
    const composed = await composeModuleTemplate({
      base: reactModuleBase,
      project,
      sdk: await buildModuleSdkPack(),
    });
    const plainBuild = "bun build src/index.ts --outdir dist --target bun";
    const serverPackagePath = "packages/server/package.json";
    const withPlainBuild = (files: Readonly<Record<string, string>>) => {
      const server = JSON.parse(files[serverPackagePath] ?? "{}") as {
        scripts: Record<string, string>;
      };
      server.scripts.build = plainBuild;
      return {
        ...files,
        [serverPackagePath]: `${JSON.stringify(server, null, 2)}\n`,
      };
    };
    const build = (files: Readonly<Record<string, string>>) =>
      (
        JSON.parse(files[serverPackagePath] ?? "{}") as {
          scripts?: Record<string, string>;
        }
      ).scripts?.build;

    expect(
      build(upgradeModuleWorkspaceSource(withPlainBuild(composed.files)))
    ).toContain("cp -R ../database/drizzle dist/drizzle");

    const withoutJournal = Object.fromEntries(
      Object.entries(withPlainBuild(composed.files)).filter(
        ([filePath]) => !filePath.startsWith("packages/database/drizzle/")
      )
    );
    expect(build(upgradeModuleWorkspaceSource(withoutJournal))).toBe(
      plainBuild
    );
  });

  it("repairs legacy release paths and restores the pinned SDK", async () => {
    const sdk = await buildModuleSdkPack();
    const composed = await composeModuleTemplate({
      base: reactModuleBase,
      project,
      sdk,
    });
    const damaged = { ...composed.files };
    const manifestSource = damaged["foundry.module.json"];
    if (manifestSource === undefined) {
      throw new Error(
        "Composed Module template must include foundry.module.json"
      );
    }
    damaged["foundry.module.json"] = manifestSource.replace(
      "outputs/packages/server/dist/index.js",
      "outputs/program/index.js"
    );
    for (const filePath of Object.keys(damaged)) {
      if (filePath.startsWith("packages/module-sdk/dist/")) {
        Reflect.deleteProperty(damaged, filePath);
      }
    }

    const upgraded = upgradeModuleWorkspaceSource(damaged, sdk);

    expect(upgraded["foundry.module.json"]).toContain(
      '"entry": "outputs/packages/server/dist/index.js"'
    );
    expect(upgraded["packages/module-sdk/dist/index.js"]).toBe(
      sdk.files["dist/index.js"]
    );
    expect(upgraded["packages/module-sdk/dist/generate.js"]).toBe(
      sdk.files["dist/generate.js"]
    );
    expect(upgradeModuleWorkspaceSource(upgraded, sdk)).toBe(upgraded);
  });

  it("upgrades version 9 development routing without changing application source", async () => {
    const composed = await composeModuleTemplate({
      base: reactModuleBase,
      project,
      sdk: await buildModuleSdkPack(),
    });
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Record keys may be absent at runtime.
    const rootPackage = JSON.parse(composed.files["package.json"] ?? "{}") as {
      devDependencies: Record<string, string>;
    };
    rootPackage.devDependencies["@parcel/watcher"] = "2.5.1";
    const legacyDatabase = `import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "./schema";

const path = process.env.FOUNDRY_MODULE_DATA_PATH ?? "/foundry/data/data.sqlite";
const client = new Database(path);
`;
    const legacy: Record<string, string> = {
      ...composed.files,
      ".foundry/provenance.json": JSON.stringify({
        format: "foundry.module-template/9",
      }),
      "package.json": `${JSON.stringify(rootPackage, null, 2)}\n`,
      "packages/database/src/index.ts": legacyDatabase,
      "packages/server/scripts/watch.ts": `export {};
const commands = [
  ["bunx", "graphql-codegen", "--config", "codegen.ts", "--watch"],
];
`,
    };

    const upgraded = upgradeModuleWorkspaceSource(legacy);

    expect(upgraded["package.json"]).not.toContain("@parcel/watcher");
    expect(upgraded["packages/server/scripts/watch.ts"]).toBeUndefined();
    expect(upgraded["package.json"]).toContain('"build": "turbo run build"');
    expect(upgraded["turbo.json"]).toContain('"persistent": true');
    expect(upgraded["eslint.config.js"]).toContain('"**/.tmp/**"');
    expect(upgraded[".foundry/scripts/watch-build.ts"]).toBeUndefined();
    expect(upgraded["packages/server/package.json"]).toContain(
      '"dev": "bun --watch src/index.ts"'
    );
    expect(upgraded["packages/app/package.json"]).toContain(
      '"dev": "bunx vite --host 0.0.0.0"'
    );
    expect(upgraded[".foundry/provenance.json"]).toContain(
      '"format": "foundry.module-template/12"'
    );
    expect(upgraded["packages/server/src/index.ts"]).toContain(
      "return serveApplication(request)"
    );
    expect(upgraded["packages/database/src/index.ts"]).toContain(
      'fileURLToPath(new URL("../.data/data.sqlite", import.meta.url))'
    );
    expect(upgraded["packages/app/src/App.tsx"]).toBe(
      legacy["packages/app/src/App.tsx"]
    );
  });

  it("repairs the bundler-inlined NODE_ENV lookup in existing Programs", async () => {
    const composed = await composeModuleTemplate({
      base: reactModuleBase,
      project,
      sdk: await buildModuleSdkPack(),
    });
    const serverPath = "packages/server/src/index.ts";
    expect(composed.files[serverPath]).toContain(
      'process.env["NODE_ENV"] === "production"'
    );

    // A workspace generated before the repair: bun build inlines the
    // dot-access lookup, freezing the built Program in development mode.
    const broken = {
      ...composed.files,
      [serverPath]: (composed.files[serverPath] ?? "").replace(
        `// Bracket lookup: bun build inlines dot-access NODE_ENV at bundle time, which
// would freeze the built Program in development mode.
const developmentAppOrigin =
  process.env["NODE_ENV"] === "production"`,
        `const developmentAppOrigin =
  process.env.NODE_ENV === "production"`
      ),
    };
    expect(broken[serverPath]).toContain("process.env.NODE_ENV ===");

    const upgraded = upgradeModuleWorkspaceSource(broken);

    expect(upgraded[serverPath]).toContain(
      'process.env["NODE_ENV"] === "production"'
    );
    expect(upgraded[serverPath]).not.toContain("process.env.NODE_ENV ===");
  });

  it("upgrades orchestration without rewriting a Bun API application", () => {
    const applicationPackage = JSON.parse(BUN_API_PACKAGE) as Record<
      string,
      unknown
    >;
    const legacy: Record<string, string> = {
      ".foundry/provenance.json": JSON.stringify({
        base: { id: "bun-api" },
        format: "foundry.module-template/6",
      }),
      "foundry.module.json": JSON.stringify({
        format: "foundry.module/1",
        views: { home: { path: "/", title: "Repaired Module" } },
      }),
      "package.json": JSON.stringify({
        name: "repaired-module",
        scripts: {
          dev: "bun run generate && bun packages/server/scripts/watch.ts",
        },
      }),
      "packages/app/index.ts": BUN_API_INDEX,
      "packages/app/package.json": `${JSON.stringify(
        {
          ...applicationPackage,
          dependencies: { "@foundry/module-sdk": "workspace:*" },
          name: "repaired-module-app",
          private: true,
        },
        null,
        2
      )}\n`,
    };

    const upgraded = upgradeModuleWorkspaceSource(legacy);

    expect(upgraded["packages/app/index.ts"]).toBe(
      legacy["packages/app/index.ts"]
    );
    expect(upgraded["packages/app/src/App.tsx"]).toBeUndefined();
    expect(upgraded["packages/app/package.json"]).toContain(
      '"dev": "bunx vite --host 0.0.0.0"'
    );
    expect(upgraded["packages/app/package.json"]).toContain(
      '"build": "bunx vite build"'
    );
    expect(upgraded["package.json"]).toContain("@types/react");
    expect(upgraded["package.json"]).toContain('"dev": "turbo run dev"');
    expect(upgraded["foundry.module.json"]).toContain('"home"');
    expect(upgraded["turbo.json"]).toContain('"persistent": true');
    expect(upgraded[".foundry/provenance.json"]).toContain(
      '"format": "foundry.module-template/12"'
    );
  });

  it("rejects a Bun API base instead of putting it in packages/app", async () => {
    await expect(
      composeModuleTemplate({
        base: bunApiBase,
        project,
        sdk: await buildModuleSdkPack(),
      })
    ).rejects.toThrow("does not provide an application build command");
  });

  it("is deterministic and records the SDK digest", async () => {
    const sdk = await buildModuleSdkPack();
    const first = await composeModuleTemplate({
      base: reactModuleBase,
      project,
      sdk,
    });
    const second = await composeModuleTemplate({
      base: reactModuleBase,
      project,
      sdk,
    });

    expect(second.files).toEqual(first.files);
    expect(first.files[".foundry/provenance.json"]).toContain(sdk.digest);
  });

  it("emits every SDK representation from the single owned entrypoint", async () => {
    const sdk = await buildModuleSdkPack();

    expect(sdk.files["src/index.ts"]).toBe(MODULE_SDK_ENTRYPOINT);
    expect(sdk.files["src/generate.ts"]).toBe(MODULE_SDK_GENERATOR_ENTRYPOINT);
    expect(sdk.files["dist/index.js"]).toContain(
      "export function createGatewayClient"
    );
    expect(sdk.files["dist/index.d.ts"]).toContain(
      "export interface GatewayTransport"
    );
    expect(sdk.files["dist/index.d.ts"]).toContain(
      "export declare function createGatewayClient"
    );
    expect(sdk.files["dist/generate.d.ts"]).toContain(
      "writeModuleGatewayClient"
    );
  });

  it("composes workspaces that upgrading leaves unchanged", async () => {
    const sdk = await buildModuleSdkPack();
    const { files } = await composeModuleTemplate({
      base: reactModuleBase,
      project,
      sdk,
    });
    expect(upgradeModuleWorkspaceSource(files)).toBe(files);
    expect(upgradeModuleWorkspaceSource(files, sdk)).toBe(files);
  });

  it("rejects incompatible bases and edited SDK packs", async () => {
    const sdk = await buildModuleSdkPack();
    await expect(
      composeModuleTemplate({ base: bunApiBase, project, sdk })
    ).rejects.toBeInstanceOf(ModuleTemplateCompositionError);

    await expect(
      composeModuleTemplate({
        base: reactModuleBase,
        project,
        sdk: {
          ...sdk,
          files: { ...sdk.files, "dist/index.js": "edited" },
        },
      })
    ).rejects.toThrow("digest does not match");
  });

  it("rejects base attempts to own reserved composer paths", async () => {
    const sdk = await buildModuleSdkPack();
    const base = {
      ...reactModuleBase,
      files: {
        ...reactModuleBase.files,
        "packages/server/src/index.ts": "malicious replacement",
      },
    };

    await expect(composeModuleTemplate({ base, project, sdk })).rejects.toThrow(
      "reserved Module composer path"
    );
  });
});
