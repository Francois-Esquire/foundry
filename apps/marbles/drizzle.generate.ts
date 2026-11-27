import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { readMigrationFiles } from "drizzle-orm/migrator";

const ROOT = import.meta.dirname;
const MIGRATIONS = join(ROOT, "src/database/migrations");
const BUNDLED_FILE = join(ROOT, "src/database/bundled-migrations.ts");
const NAME = "init";
const SQL = `0000_${NAME}.sql`;
const JOURNAL = join("meta", "_journal.json");
const UNRELEASED = 0;

interface Journal {
  entries: { tag: string; when: number }[];
}

export function generateMigrations(): void {
  const staged = mkdtempSync(join(tmpdir(), "marbles-migrations-"));
  try {
    const generated = spawnSync(
      resolve(ROOT, "../../node_modules/.bin/drizzle-kit"),
      [
        "generate",
        "--dialect",
        "sqlite",
        "--schema",
        "./src/database/schema.ts",
        "--out",
        relative(ROOT, staged),
        "--name",
        NAME,
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, NODE_OPTIONS: "--conditions=import" },
      }
    );
    if (generated.status !== 0) {
      throw new Error(
        `drizzle-kit could not generate the Marbles migrations: ${generated.stdout}${generated.stderr}`
      );
    }
    const journal = JSON.parse(
      readFileSync(join(staged, JOURNAL), "utf8")
    ) as Journal;
    for (const entry of journal.entries) {
      entry.when = UNRELEASED;
    }
    writeFileSync(join(staged, JOURNAL), JSON.stringify(journal, null, 2));
    const bundledSource = bundled(staged, journal);
    if (
      !existsSync(BUNDLED_FILE) ||
      readFileSync(BUNDLED_FILE, "utf8") !== bundledSource
    ) {
      writeFileSync(BUNDLED_FILE, bundledSource);
    }
    if (sameMigrations(staged)) {
      return;
    }
    rmSync(MIGRATIONS, { force: true, recursive: true });
    cpSync(staged, MIGRATIONS, { recursive: true });
  } finally {
    rmSync(staged, { force: true, recursive: true });
  }
}

function bundled(staged: string, journal: Journal): string {
  const migrations = readMigrationFiles({ migrationsFolder: staged }).map(
    (migration, index) =>
      [
        "  {",
        `    hash: ${JSON.stringify(migration.hash)},`,
        "    sql: [",
        ...migration.sql.map(
          (statement) => `      ${JSON.stringify(statement)},`
        ),
        "    ],",
        `    tag: ${JSON.stringify(journal.entries[index]?.tag ?? String(index))},`,
        `    when: ${String(migration.folderMillis)},`,
        "  },",
      ].join("\n")
  );
  return `export const BUNDLED_MIGRATIONS = [\n${migrations.join("\n")}\n] as const;\n`;
}

function sameMigrations(staged: string): boolean {
  return [SQL, JOURNAL].every(
    (file) =>
      existsSync(join(MIGRATIONS, file)) &&
      readFileSync(join(MIGRATIONS, file), "utf8") ===
        readFileSync(join(staged, file), "utf8")
  );
}

if (import.meta.main) {
  generateMigrations();
}
