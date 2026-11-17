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

const ROOT = import.meta.dirname;
const MIGRATIONS = join(ROOT, "src/database/migrations");
const NAME = "init";
const SQL = `0000_${NAME}.sql`;
const JOURNAL = join("meta", "_journal.json");
const UNRELEASED = 0;

interface Journal {
  entries: { when: number }[];
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
    if (sameMigrations(staged)) {
      return;
    }
    rmSync(MIGRATIONS, { force: true, recursive: true });
    cpSync(staged, MIGRATIONS, { recursive: true });
  } finally {
    rmSync(staged, { force: true, recursive: true });
  }
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
