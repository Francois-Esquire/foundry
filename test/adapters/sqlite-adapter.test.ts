import { rm } from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import { SQLiteAdapter } from '../../src/adapters';
import { createAdapterTests } from './adapter-test-suite';
import type { Adapter } from '../../src/core/types';

// For file-based testing, use a temp file that will be cleaned up
const TEST_FILE_DB_PATH = './test/tmp/test-sqlite.db';

// Tests with file-based database to ensure file persistence works
createAdapterTests(
  'SQLite (File-Based)',
  () => {
    // Ensure the directory exists
    if (!existsSync('./test/tmp')) {
      mkdirSync('./test/tmp', { recursive: true });
    }
    return new SQLiteAdapter({ databasePath: TEST_FILE_DB_PATH });
  },
  // Cleanup: close the database and delete the file
  async (adapter: Adapter) => {
    (adapter as SQLiteAdapter).close();
    if (existsSync(TEST_FILE_DB_PATH)) {
      await rm(TEST_FILE_DB_PATH);
    }
  }
);
