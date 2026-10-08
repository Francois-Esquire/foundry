import { MODULE_MANIFEST_SOURCE_PATH } from "../manifest";
import type { ModuleSdkPack } from "../sdk";
import {
  MODULE_TEMPLATE_COMPOSER_GENERATION,
  MODULE_TEMPLATE_COMPOSER_VERSION,
} from "./compose";
import { formatJson, isRecord, parseJsonRecord } from "./json";
import {
  APP_DEPENDENCIES,
  APP_DEV_DEPENDENCIES,
  APP_PACKAGE_SCRIPTS,
  BUN_BUILD_SCRIPT,
  DATABASE_INDEX_SOURCE,
  DATABASE_PACKAGE_SCRIPTS,
  DEVELOPMENT_DATABASE_IMPORTS,
  DEVELOPMENT_DATABASE_PATH_SOURCE,
  ESLINT_CONFIGURATION_SOURCE,
  GENERATE_SCHEMA_SOURCE,
  INLINE_SCHEMA_DATABASE_INDEX_SOURCE,
  INLINE_SCHEMA_NOTES_MIGRATION_SOURCE,
  LEGACY_DATABASE_PATH_SOURCE,
  LEGACY_MODULE_CLIENT_SOURCE,
  MODULE_CLIENT_SOURCE,
  NOTES_MIGRATION_SOURCE,
  PACKAGE_MANAGER,
  PACKAGE_WIRING_FILES,
  PRETTIER_IGNORE_SOURCE,
  PROGRAM_GATEWAY_HEARTBEAT_SOURCE,
  PROGRAM_STATIC_CONFIGURATION,
  PROGRAM_STATIC_IMPORTS,
  ROOT_DEV_DEPENDENCIES,
  SERVER_PACKAGE_SCRIPTS,
  TURBO_CONFIGURATION_SOURCE,
  WORKSPACE_SCRIPTS,
} from "./scaffold";

const DATABASE_INDEX_PATH = "packages/database/src/index.ts";
const NOTES_MIGRATION_PATH = "packages/database/drizzle/0000_notes.sql";
const SERVER_INDEX_PATH = "packages/server/src/index.ts";
const COMPOSER_FORMAT = /^foundry\.module-template\/([1-9]\d*)$/u;
const DATABASE_FILE_PATH = /\.sqlite(?:-(?:wal|shm))?$/u;
const LINE_BREAK = /\r?\n/u;
const TRAILING_WHITESPACE = /\s*$/u;

/** Locations earlier composers wrote that the current layout no longer has. */
const OBSOLETE_PATHS: ReadonlySet<string> = new Set([
  ".foundry/scripts/watch-build.ts",
  "codegen.ts",
  "packages/app/src/foundry-env.d.ts",
  "packages/server/scripts/generate-gateway.ts",
  "packages/server/scripts/generate.ts",
  "packages/server/scripts/watch.ts",
]);

type FileUpgrade = (
  source: string,
  files: Readonly<Record<string, string>>
) => string;

/**
 * Applied in order to each path present. A path may appear more than once
 * when a later repair assumes an earlier one already ran.
 */
const FILE_UPGRADES: readonly (readonly [string, FileUpgrade])[] = [
  [
    MODULE_MANIFEST_SOURCE_PATH,
    (source, files) =>
      upgradeComposerManifest(
        ensureComposerDefaultView(source, rootPackageName(files))
      ),
  ],
  [DATABASE_INDEX_PATH, upgradeLegacyDatabasePath],
  [
    SERVER_INDEX_PATH,
    (source) =>
      upgradeProgramEnvironmentLookup(upgradeProgramDevelopmentProxy(source)),
  ],
  ["packages/app/vite.config.ts", upgradeViteDevelopmentProxy],
  [
    "package.json",
    (source) =>
      upgradeDevelopmentScripts(removeParcelWatcherDependency(source)),
  ],
  ["packages/app/package.json", upgradeApplicationPackage],
  [
    "packages/server/package.json",
    (source, files) =>
      upgradePackageScripts(source, {
        ...SERVER_PACKAGE_SCRIPTS,
        // Only a workspace with a migration journal has migrations to copy.
        ...(files["packages/database/drizzle/meta/_journal.json"] === undefined
          ? { build: BUN_BUILD_SCRIPT }
          : {}),
      }),
  ],
  [
    "packages/database/package.json",
    (source) => upgradePackageScripts(source, DATABASE_PACKAGE_SCRIPTS),
  ],
  ["tsconfig.json", upgradeApplicationTypeScript],
  [
    SERVER_INDEX_PATH,
    (source) =>
      upgradeProgramGatewayHeartbeat(upgradeProgramStaticServing(source)),
  ],
  ["turbo.json", upgradeTurboConfiguration],
  [
    "packages/app/src/module-client.ts",
    (source) =>
      source === LEGACY_MODULE_CLIENT_SOURCE ? MODULE_CLIENT_SOURCE : source,
  ],
  [
    ".gitignore",
    (source) =>
      appendMissingLines(source, [
        ".tmp/",
        ".turbo/",
        "!packages/module-sdk/dist/",
        "!packages/module-sdk/dist/**",
      ]),
  ],
];

/** Seeded only when absent; an authored copy is never replaced. */
const COMPOSER_INFRASTRUCTURE: Readonly<Record<string, string>> = {
  ".prettierignore": PRETTIER_IGNORE_SOURCE,
  "eslint.config.js": ESLINT_CONFIGURATION_SOURCE,
  "turbo.json": TURBO_CONFIGURATION_SOURCE,
  ...PACKAGE_WIRING_FILES,
  "packages/server/scripts/generate-schema.ts": GENERATE_SCHEMA_SOURCE,
};

/**
 * Repairs composer-owned infrastructure for recognized Module workspaces.
 * User-authored files and workspaces without matching provenance pass through
 * untouched; current provenance remains eligible because authored changes can
 * structurally drift required orchestration after composition.
 */
export function upgradeModuleWorkspaceSource(
  source: Readonly<Record<string, string>>,
  sdk?: ModuleSdkPack
): Readonly<Record<string, string>> {
  const provenance = composerProvenance(source);
  if (provenance === null) {
    return source;
  }

  const files = { ...source };
  for (const filePath of Object.keys(files)) {
    if (OBSOLETE_PATHS.has(filePath) || isGeneratedPath(filePath)) {
      Reflect.deleteProperty(files, filePath);
    }
  }
  for (const [filePath, upgrade] of FILE_UPGRADES) {
    const current = files[filePath];
    if (current !== undefined) {
      files[filePath] = upgrade(current, files);
    }
  }
  // Only a byte-identical composer pair is replaced: an authored database
  // module keeps working through the legacy path variable hosts still set,
  // and a migrator against an authored first migration would fail.
  if (
    files[DATABASE_INDEX_PATH] === INLINE_SCHEMA_DATABASE_INDEX_SOURCE &&
    files[NOTES_MIGRATION_PATH] === INLINE_SCHEMA_NOTES_MIGRATION_SOURCE
  ) {
    files[DATABASE_INDEX_PATH] = DATABASE_INDEX_SOURCE;
    files[NOTES_MIGRATION_PATH] = NOTES_MIGRATION_SOURCE;
  }
  for (const [filePath, value] of Object.entries(COMPOSER_INFRASTRUCTURE)) {
    files[filePath] ??= value;
  }
  if (sdk !== undefined) {
    syncModuleSdk(files, sdk);
  }
  files[".foundry/provenance.json"] = formatJson({
    ...provenance,
    format: MODULE_TEMPLATE_COMPOSER_VERSION,
    ...(sdk === undefined
      ? {}
      : { sdk: { digest: sdk.digest, version: sdk.version } }),
  });

  return sameWorkspaceSource(files, source) ? source : Object.freeze(files);
}

function composerProvenance(
  source: Readonly<Record<string, string>>
): Record<string, unknown> | null {
  const provenance = parseJsonRecord(source[".foundry/provenance.json"]);
  return provenance !== null && isComposerFormat(provenance.format)
    ? provenance
    : null;
}

function isComposerFormat(format: unknown): boolean {
  const generation =
    typeof format === "string" ? COMPOSER_FORMAT.exec(format)?.[1] : undefined;
  return (
    generation !== undefined &&
    Number(generation) <= MODULE_TEMPLATE_COMPOSER_GENERATION
  );
}

function isGeneratedPath(filePath: string): boolean {
  return (
    filePath === ".foundry/generated" ||
    filePath.startsWith(".foundry/generated/") ||
    filePath.split("/").includes(".data") ||
    DATABASE_FILE_PATH.test(filePath)
  );
}

function syncModuleSdk(
  files: Record<string, string>,
  sdk: ModuleSdkPack
): void {
  const sdkRoot = "packages/module-sdk/";
  for (const filePath of Object.keys(files)) {
    if (
      filePath.startsWith(sdkRoot) &&
      sdk.files[filePath.slice(sdkRoot.length)] === undefined
    ) {
      Reflect.deleteProperty(files, filePath);
    }
  }
  for (const [filePath, value] of Object.entries(sdk.files)) {
    files[`${sdkRoot}${filePath}`] = value;
  }
}

function rootPackageName(files: Readonly<Record<string, string>>): string {
  const rootPackage = parseJsonRecord(files["package.json"]);
  return rootPackage !== null && typeof rootPackage.name === "string"
    ? rootPackage.name
    : "module";
}

function upgradeLegacyDatabasePath(source: string): string {
  if (!source.includes(LEGACY_DATABASE_PATH_SOURCE)) {
    return source;
  }
  return source
    .replace(
      'import { Database } from "bun:sqlite";',
      DEVELOPMENT_DATABASE_IMPORTS
    )
    .replace(LEGACY_DATABASE_PATH_SOURCE, DEVELOPMENT_DATABASE_PATH_SOURCE);
}

function removeParcelWatcherDependency(source: string): string {
  const parsed = parseJsonRecord(source);
  if (parsed === null || !isRecord(parsed.devDependencies)) {
    return source;
  }
  if (parsed.devDependencies["@parcel/watcher"] === undefined) {
    return source;
  }
  const devDependencies = { ...parsed.devDependencies };
  Reflect.deleteProperty(devDependencies, "@parcel/watcher");
  return formatJson({ ...parsed, devDependencies });
}

function appendMissingLines(source: string, lines: readonly string[]): string {
  const existing = new Set(source.split(LINE_BREAK));
  const missing = lines.filter((line) => !existing.has(line));
  if (missing.length === 0) {
    return source;
  }
  return `${source.replace(TRAILING_WHITESPACE, "")}\n${missing.join("\n")}\n`;
}

function ensureComposerDefaultView(source: string, title: string): string {
  const parsed = parseJsonRecord(source);
  if (parsed === null || !isRecord(parsed.views)) {
    return source;
  }
  if (Object.keys(parsed.views).length > 0) {
    return source;
  }
  return formatJson({ ...parsed, views: { home: { path: "/", title } } });
}

function upgradeComposerManifest(source: string): string {
  const parsed = parseJsonRecord(source);
  if (parsed === null || !isRecord(parsed.program)) {
    return source;
  }
  if (parsed.program.entry !== "outputs/program/index.js") {
    return source;
  }
  return formatJson({
    ...parsed,
    program: {
      ...parsed.program,
      entry: "outputs/packages/server/dist/index.js",
    },
  });
}

function upgradeDevelopmentScripts(source: string): string {
  const parsed = parseJsonRecord(source);
  if (parsed === null || !isRecord(parsed.scripts)) {
    return source;
  }
  return formatJson({
    ...parsed,
    devDependencies: {
      ...cleanRootDevDependencies(parsed.devDependencies),
      ...ROOT_DEV_DEPENDENCIES,
    },
    packageManager: PACKAGE_MANAGER,
    scripts: WORKSPACE_SCRIPTS,
  });
}

function cleanRootDevDependencies(value: unknown): Record<string, unknown> {
  const dependencies = isRecord(value) ? { ...value } : {};
  Reflect.deleteProperty(dependencies, "@graphql-codegen/cli");
  Reflect.deleteProperty(dependencies, "@graphql-codegen/client-preset");
  Reflect.deleteProperty(dependencies, "@graphql-typed-document-node/core");
  Reflect.deleteProperty(dependencies, "graphql");
  return dependencies;
}

function upgradePackageScripts(
  source: string,
  scripts: Readonly<Record<string, string>>
): string {
  const parsed = parseJsonRecord(source);
  if (parsed === null) {
    return source;
  }
  return formatJson({
    ...parsed,
    scripts: {
      ...(isRecord(parsed.scripts) ? parsed.scripts : {}),
      ...scripts,
    },
  });
}

function upgradeApplicationPackage(source: string): string {
  const parsed = parseJsonRecord(source);
  if (parsed === null) {
    return source;
  }
  return formatJson({
    ...parsed,
    dependencies: {
      ...(isRecord(parsed.dependencies) ? parsed.dependencies : {}),
      ...APP_DEPENDENCIES,
    },
    devDependencies: {
      ...(isRecord(parsed.devDependencies) ? parsed.devDependencies : {}),
      ...APP_DEV_DEPENDENCIES,
    },
    scripts: {
      ...(isRecord(parsed.scripts) ? parsed.scripts : {}),
      ...APP_PACKAGE_SCRIPTS,
    },
  });
}

function upgradeProgramDevelopmentProxy(source: string): string {
  if (
    source.includes("developmentAppOrigin") ||
    !source.includes(
      "async function serveApplication(pathname: string): Promise<Response>"
    )
  ) {
    return source;
  }
  return source
    .replace(
      `const appRoot = resolve(
  process.env.FOUNDRY_MODULE_APP_PATH ??
    fileURLToPath(new URL("../../app/dist", import.meta.url)),
);`,
      `const appRoot = resolve(
  process.env.FOUNDRY_MODULE_APP_PATH ??
    fileURLToPath(new URL("../../app/dist", import.meta.url)),
);
// Bracket lookup: bun build inlines dot-access NODE_ENV at bundle time, which
// would freeze the built Program in development mode.
const developmentAppOrigin =
  process.env["NODE_ENV"] === "production"
    ? undefined
    : "http://127.0.0.1:" + (process.env.VITE_PORT ?? "5173");`
    )
    .replace(
      `async function serveApplication(pathname: string): Promise<Response> {
  let relative: string;`,
      `async function serveApplication(request: Request): Promise<Response> {
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
  let relative: string;`
    )
    .replace("decodeURIComponent(pathname)", "decodeURIComponent(url.pathname)")
    .replace(
      "return serveApplication(url.pathname);",
      "return serveApplication(request);"
    );
}

function upgradeProgramEnvironmentLookup(source: string): string {
  return source.replace(
    `const developmentAppOrigin =
  process.env.NODE_ENV === "production"`,
    `// Bracket lookup: bun build inlines dot-access NODE_ENV at bundle time, which
// would freeze the built Program in development mode.
const developmentAppOrigin =
  process.env["NODE_ENV"] === "production"`
  );
}

function upgradeProgramGatewayHeartbeat(source: string): string {
  if (
    !(
      source.includes("const gatewayModes =") &&
      source.includes('socket.close(1002, "Gateway hello is invalid")')
    ) ||
    source.includes('frame.kind === "heartbeat"')
  ) {
    return source;
  }
  return source.replace(
    "        const frame: unknown = JSON.parse(message);",
    `$&\n${PROGRAM_GATEWAY_HEARTBEAT_SOURCE}`
  );
}

function upgradeViteDevelopmentProxy(source: string): string {
  return source.replace(
    `    hmr: {
      clientPort: Number(process.env.VITE_PORT ?? 5173),
    },
`,
    ""
  );
}

function upgradeApplicationTypeScript(source: string): string {
  const parsed = parseJsonRecord(source);
  if (parsed === null || !isRecord(parsed.compilerOptions)) {
    return source;
  }
  const types = Array.isArray(parsed.compilerOptions.types)
    ? parsed.compilerOptions.types.filter(
        (value): value is string =>
          typeof value === "string" && value !== "vite/client"
      )
    : [];
  if (
    parsed.compilerOptions.jsx === "react-jsx" &&
    types.includes("react") &&
    types.includes("react-dom") &&
    !source.includes('"vite/client"')
  ) {
    return source;
  }
  return formatJson({
    ...parsed,
    compilerOptions: {
      ...parsed.compilerOptions,
      jsx: "react-jsx",
      types: [...new Set([...types, "bun", "react", "react-dom"])],
    },
  });
}

function upgradeProgramStaticServing(source: string): string {
  if (
    !(
      source.includes('import { buildSchema } from "drizzle-graphql";') &&
      source.includes("  fetch(request, server) {") &&
      source.includes("    return yoga.fetch(request);")
    )
  ) {
    return source;
  }
  return source
    .replace(
      'import { buildSchema } from "drizzle-graphql";',
      PROGRAM_STATIC_IMPORTS +
        '\n\nimport { buildSchema } from "drizzle-graphql";'
    )
    .replace(
      "const port = Number(process.env.PORT ?? 3000);",
      PROGRAM_STATIC_CONFIGURATION +
        "\n\nconst port = Number(process.env.PORT ?? 3000);"
    )
    .replace("  fetch(request, server) {", "  async fetch(request, server) {")
    .replace(
      "    return yoga.fetch(request);",
      '    if (url.pathname.startsWith("/_module/")) return yoga.fetch(request);\n' +
        "    return serveApplication(url.pathname);"
    );
}

function upgradeTurboConfiguration(source: string): string {
  const current = parseJsonRecord(source);
  const required = parseJsonRecord(TURBO_CONFIGURATION_SOURCE);
  if (current === null || required === null || !isRecord(required.tasks)) {
    return source;
  }

  const currentTasks = isRecord(current.tasks) ? current.tasks : {};
  const tasks: Record<string, unknown> = { ...currentTasks };
  for (const [name, requiredValue] of Object.entries(required.tasks)) {
    if (!isRecord(requiredValue)) {
      continue;
    }
    const currentValue = isRecord(currentTasks[name]) ? currentTasks[name] : {};
    const task: Record<string, unknown> = { ...currentValue, ...requiredValue };
    for (const field of ["dependsOn", "outputs"] as const) {
      if (
        requiredValue[field] === undefined &&
        currentValue[field] === undefined
      ) {
        continue;
      }
      task[field] = mergeStringArrays(
        requiredValue[field],
        currentValue[field]
      );
    }
    tasks[name] = task;
  }

  return formatJson({
    ...current,
    $schema: required.$schema,
    globalEnv: mergeStringArrays(required.globalEnv, current.globalEnv),
    tasks,
    ui: required.ui,
  });
}

function mergeStringArrays(required: unknown, current: unknown): string[] {
  return [
    ...new Set(
      [required, current].flatMap((value) =>
        Array.isArray(value)
          ? value.filter((entry): entry is string => typeof entry === "string")
          : []
      )
    ),
  ];
}

function sameWorkspaceSource(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>
): boolean {
  const leftPaths = Object.keys(left);
  const rightPaths = Object.keys(right);
  return (
    leftPaths.length === rightPaths.length &&
    leftPaths.every((filePath) => left[filePath] === right[filePath])
  );
}
