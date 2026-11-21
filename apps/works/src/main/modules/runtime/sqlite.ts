import { DatabaseSync } from "node:sqlite";

export function snapshotSqlite(
  source: string,
  destination: string
): Promise<void> {
  const database = new DatabaseSync(source, { readOnly: true });
  try {
    const mode = database.prepare("PRAGMA journal_mode").get()?.journal_mode;
    database.prepare("VACUUM INTO ?").run(destination);
    if (mode === "wal") {
      const copy = new DatabaseSync(destination);
      try {
        copy.exec("PRAGMA journal_mode = WAL");
      } finally {
        copy.close();
      }
    }
  } finally {
    database.close();
  }
  return Promise.resolve();
}

export function checkSqlite(file: string): Promise<void> {
  const database = new DatabaseSync(file);
  try {
    const rows = database.prepare("PRAGMA integrity_check").all();
    const result = rows.map((row) => Object.values(row)[0]);
    if (result.length !== 1 || result[0] !== "ok") {
      throw new Error(`SQLite integrity check failed: ${result.join("; ")}`);
    }
  } finally {
    database.close();
  }
  return Promise.resolve();
}
