import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../.."
);
const SOURCE = join(PACKAGE_ROOT, "src");

const SQLITE_ENTRIES = ["./store/sqlite", "./store/tables"];

const SQLITE_STACK = /^(drizzle-orm|@libsql\/)/;
const DRIZZLE = /^drizzle-orm/;
const LIBSQL = /^@libsql\//;

const STATIC_IMPORT =
  /^\s*(?:import|export)\s+(type\s+)?(?:[^;]*?\s+from\s+)?["']([^"']+)["']/gm;
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

interface Manifest {
  readonly exports: Readonly<Record<string, { readonly import: string }>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: Readonly<
    Record<string, { readonly optional?: boolean }>
  >;
}

const manifest = JSON.parse(
  readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")
) as Manifest;

function importsOf(file: string) {
  const text = readFileSync(file, "utf8");
  return [
    ...[...text.matchAll(STATIC_IMPORT)].map((match) => ({
      specifier: match[2] ?? "",
      typeOnly: match[1] !== undefined,
    })),
    ...[...text.matchAll(DYNAMIC_IMPORT)].map((match) => ({
      specifier: match[1] ?? "",
      typeOnly: false,
    })),
  ];
}

function resolved(file: string, specifier: string): string {
  const base = resolve(dirname(file), specifier);
  for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  throw new Error(
    `${relative(SOURCE, file)} imports ${specifier}, which is no file`
  );
}

function entryFiles(target: string): string[] {
  const path = join(PACKAGE_ROOT, target);
  if (!path.includes("*")) {
    return [path];
  }
  const directory = dirname(path);
  return readdirSync(directory)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(directory, name));
}

function runtimeGraph(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const pending = [...entries];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    for (const { specifier, typeOnly } of importsOf(file)) {
      if (!typeOnly && specifier.startsWith(".")) {
        pending.push(resolved(file, specifier));
      }
    }
  }
  return [...seen];
}

function sourceFiles(): string[] {
  return readdirSync(SOURCE, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => !relative(SOURCE, file).startsWith("test/"));
}

describe("@foundry/agents public paths", () => {
  it("maps every export path to files that exist", () => {
    const missing = Object.entries(manifest.exports).flatMap(
      ([path, target]) => {
        const files = entryFiles(target.import);
        return files.length === 0 || !files.every((file) => existsSync(file))
          ? [path]
          : [];
      }
    );

    expect(missing).toEqual([]);
  });

  it("maps the store, both stores, the tables and the suite to their files", () => {
    expect(
      Object.fromEntries(
        [
          "./store",
          "./store/memory",
          "./store/sqlite",
          "./store/tables",
          "./testing/store",
        ].map((path) => [path, manifest.exports[path]?.import])
      )
    ).toEqual({
      "./store": "./src/store/index.ts",
      "./store/memory": "./src/store/memory.ts",
      "./store/sqlite": "./src/store/sqlite.ts",
      "./store/tables": "./src/store/tables.ts",
      "./testing/store": "./src/testing/store.ts",
    });
  });

  it("exports the SQLite store, its write capture and its tables, and nothing else, from their paths", async () => {
    expect(Object.keys(await import("../../store/sqlite")).sort()).toEqual([
      "SqliteSessionStore",
      "capturedSessionWrite",
    ]);
    expect(Object.keys(await import("../../store/tables")).sort()).toEqual([
      "agentMessages",
      "agentSessions",
    ]);
    expect(Object.keys(await import("../../store/index"))).toEqual([]);
    expect(Object.keys(await import("../../store/memory"))).toEqual([
      "InMemorySessionStore",
    ]);
  }, 30_000);
});

describe("@foundry/agents SQLite dependencies", () => {
  it("keeps Drizzle an optional peer", () => {
    expect(manifest.peerDependencies?.["drizzle-orm"]).toBeDefined();
    expect(manifest.peerDependenciesMeta?.["drizzle-orm"]?.optional).toBe(true);
  });

  it("imports Drizzle only in the SQLite store and its tables, and libSQL nowhere", () => {
    const importers = (pattern: RegExp) =>
      sourceFiles()
        .filter((file) =>
          importsOf(file).some(({ specifier }) => pattern.test(specifier))
        )
        .map((file) => relative(SOURCE, file))
        .sort();

    expect(importers(DRIZZLE)).toEqual(["store/sqlite.ts", "store/tables.ts"]);
    expect(importers(LIBSQL)).toEqual([]);
  });

  it("loads no Drizzle from any other entry, the memory store included, through any import chain", () => {
    const entries = Object.entries(manifest.exports)
      .filter(([path]) => !SQLITE_ENTRIES.includes(path))
      .flatMap(([, target]) => entryFiles(target.import));
    const graph = runtimeGraph(entries);
    expect(graph).toContain(join(SOURCE, "store/memory.ts"));
    expect(graph).toContain(join(SOURCE, "session/sessions.ts"));

    const loading = graph.flatMap((file) =>
      importsOf(file)
        .filter(
          ({ specifier, typeOnly }) => !typeOnly && SQLITE_STACK.test(specifier)
        )
        .map(({ specifier }) => `${relative(SOURCE, file)} loads ${specifier}`)
    );
    expect(loading).toEqual([]);
    expect(graph).not.toContain(join(SOURCE, "store/sqlite.ts"));
    expect(graph).not.toContain(join(SOURCE, "store/tables.ts"));
  });
});
