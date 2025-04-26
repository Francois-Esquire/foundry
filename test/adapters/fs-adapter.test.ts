import { rm } from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import { FileSystemAdapter } from '../../src/adapters';
import { createAdapterTests } from './adapter-test-suite';
import type { Adapter } from '../../src/core/types';

// For file-based testing, use a temp directory that will be cleaned up
const TEST_DIR_PATH = './test/tmp/fs-adapter';

// Tests with real file system
createAdapterTests(
  'FileSystem',
  () => {
    // Ensure the test directory exists
    if (!existsSync(TEST_DIR_PATH)) {
      mkdirSync(TEST_DIR_PATH, { recursive: true });
    }
    return new FileSystemAdapter({ basePath: TEST_DIR_PATH });
  },
  // Cleanup: remove the test directory
  async (adapter: Adapter) => {
    if (existsSync(TEST_DIR_PATH)) {
      await rm(TEST_DIR_PATH, { recursive: true, force: true });
    }
  }
);
