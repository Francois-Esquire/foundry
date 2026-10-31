import { DatabaseSync } from "node:sqlite";

/**
 * A consistent copy of a Module's SQLite database, WAL included, taken with
 * its Program stopped: the Installation files backup before a Version
 * change, and the staged copy of a private data move. `destination` must
 * not exist yet.
 *
 * `VACUUM INTO` copies on this thread. `node:sqlite`'s asynchronous
 * `backup()` left libuv's thread pool stuck after a few calls in the test
 * runner (every later file operation waited forever), so it is not used.
 */
export function snapshotSqlite(
  source: string,
  destination: string
): Promise<void> {
  // Read-only, so closing it never checkpoints or removes the original's WAL.
  const database = new DatabaseSync(source, { readOnly: true });
  try {
    const mode = database.prepare("PRAGMA journal_mode").get()?.journal_mode;
    database.prepare("VACUUM INTO ?").run(destination);
    if (mode === "wal") {
      // The copy keeps the original's journal mode, as a backup would.
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

/**
 * Opens the database where it lies and runs SQLite's integrity check, then
 * closes it. Throws when it cannot be opened or the check reports damage.
 */
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
