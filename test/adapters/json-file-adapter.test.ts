import { rm } from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import { JsonFileAdapter } from '../../src/adapters/json-file';
import { createAdapterTests } from './adapter-test-suite';
import type { Adapter } from '../../src/adapters/types';
import * as path from 'path';

// For file-based testing, use a temp directory that will be cleaned up
const TEST_DIR_PATH = './test/tmp/json-file-adapter';
const TEST_FILE_PATH = path.join(TEST_DIR_PATH, 'data.json');

// Tests with file-based storage
createAdapterTests(
  'JsonFile',
  () => {
    // Ensure the test directory exists
    if (!existsSync(TEST_DIR_PATH)) {
      mkdirSync(TEST_DIR_PATH, { recursive: true });
    }
    return new JsonFileAdapter({ filePath: TEST_FILE_PATH });
  },
  // Cleanup: remove the test directory
  async (adapter: Adapter) => {
    if (existsSync(TEST_DIR_PATH)) {
      await rm(TEST_DIR_PATH, { recursive: true, force: true });
    }
  }
);
