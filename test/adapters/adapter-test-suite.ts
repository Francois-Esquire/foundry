import { expect, test, describe, beforeEach, afterEach } from 'bun:test';
import type { Adapter } from '../../src/adapters/types';

/**
 * A set of common tests that should work for all adapters
 * @param adapterName Name of the adapter for test descriptions
 * @param createAdapter Function that returns a fresh adapter instance for each test
 * @param cleanupAdapter Function that cleans up any resources used by the adapter
 * @returns A test suite for the adapter
 */
export function createAdapterTests(
  adapterName: string,
  createAdapter: () => Adapter,
  cleanupAdapter?: (adapter: Adapter) => Promise<void>
) {
  const baseTests = describe(`${adapterName} Adapter`, () => {
    // Setup and teardown logic
    let adapter: Adapter;

    beforeEach(() => {
      adapter = createAdapter();
    });

    afterEach(async () => {
      if (cleanupAdapter) {
        await cleanupAdapter(adapter);
      }
    });

    // Basic Operations
    describe('Basic Operations', () => {
      test('write and read content', async () => {
        const path = 'test-file.txt';
        const content = 'Hello, World!';
        const type = 'text/plain';

        const writeResult = await adapter.write(path, content, type);
        expect(writeResult).toBe(true);

        const readResult = await adapter.read(path);
        expect(readResult).not.toBeNull();
        expect(readResult?.content).toBe(content);
        expect(readResult?.type).toBe(type);
      });

      test('check if path exists', async () => {
        const path = 'exists-test.txt';

        // Should not exist initially
        let existsResult = await adapter.exists(path);
        expect(existsResult).toBe(false);

        // Write content
        await adapter.write(path, 'test content', 'text/plain');

        // Should exist after writing
        existsResult = await adapter.exists(path);
        expect(existsResult).toBe(true);
      });

      test('delete content', async () => {
        const path = 'delete-test.txt';

        // Write content
        await adapter.write(path, 'test content', 'text/plain');

        // Should exist after writing
        let existsResult = await adapter.exists(path);
        expect(existsResult).toBe(true);

        // Delete content
        const deleteResult = await adapter.delete(path);
        expect(deleteResult).toBe(true);

        // Should not exist after deleting
        existsResult = await adapter.exists(path);
        expect(existsResult).toBe(false);
      });

      test('read non-existent path returns null', async () => {
        const path = 'non-existent-file.txt';
        const readResult = await adapter.read(path);
        expect(readResult).toBeNull();
      });

      test('deleting non-existent path returns false', async () => {
        const path = 'non-existent-file.txt';
        const deleteResult = await adapter.delete(path);
        expect(deleteResult).toBe(false);
      });
    });

    // Directory Operations
    describe('Directory Operations', () => {
      test('create and list directory', async () => {
        const dirPath = 'test-dir';

        // Create directory
        const createResult = await adapter.createDirectory(dirPath);
        expect(createResult).toBe(true);

        // Directory should exist
        const existsResult = await adapter.exists(dirPath);
        expect(existsResult).toBe(true);

        // Should be able to list empty directory
        const listResult = await adapter.list(dirPath);
        expect(Array.isArray(listResult)).toBe(true);
        expect(listResult.length).toBe(0);
      });

      test('list files in directory', async () => {
        const dirPath = 'list-dir';
        const file1 = `${dirPath}/file1.txt`;
        const file2 = `${dirPath}/file2.txt`;

        // Create directory and files
        await adapter.createDirectory(dirPath);
        await adapter.write(file1, 'content 1', 'text/plain');
        await adapter.write(file2, 'content 2', 'text/plain');

        // List directory contents
        const listResult = await adapter.list(dirPath);
        expect(listResult.length).toBe(2);
        expect(listResult).toContain('file1.txt');
        expect(listResult).toContain('file2.txt');
      });

      test('list nested directories', async () => {
        const mainDir = 'main-dir';
        const subDir = `${mainDir}/sub-dir`;

        // Create directories
        await adapter.createDirectory(mainDir);
        await adapter.createDirectory(subDir);

        // List main directory
        const listResult = await adapter.list(mainDir);
        expect(listResult.length).toBe(1);
        expect(listResult).toContain('sub-dir');
      });

      test('delete directory', async () => {
        const dirPath = 'delete-dir';

        // Create directory
        await adapter.createDirectory(dirPath);

        // Directory should exist
        let existsResult = await adapter.exists(dirPath);
        expect(existsResult).toBe(true);

        // Delete directory
        const deleteResult = await adapter.deleteDirectory(dirPath);
        expect(deleteResult).toBe(true);

        // Directory should not exist after deletion
        existsResult = await adapter.exists(dirPath);
        expect(existsResult).toBe(false);
      });

      test.skip('delete non-empty directory fails without recursive flag', async () => {
        const dirPath = 'non-empty-dir';
        const filePath = `${dirPath}/file.txt`;

        // Create directory and file
        await adapter.createDirectory(dirPath);
        await adapter.write(filePath, 'content', 'text/plain');

        expect(async () => await adapter.deleteDirectory(dirPath)).toThrowError(
          new Error(
            `Directory is not empty: ${dirPath}. Pass recursive=true to delete contents.`
          )
        );

        // Directory should still exist
        const existsResult = await adapter.exists(dirPath);
        expect(existsResult).toBe(true);
      });

      test('delete non-empty directory with recursive flag succeeds', async () => {
        const dirPath = 'recursive-delete-dir';
        const filePath = `${dirPath}/file.txt`;
        const subDirPath = `${dirPath}/sub-dir`;
        const subFilePath = `${subDirPath}/sub-file.txt`;

        // Create directory structure
        await adapter.createDirectory(dirPath);
        await adapter.write(filePath, 'content', 'text/plain');
        await adapter.createDirectory(subDirPath);
        await adapter.write(subFilePath, 'sub content', 'text/plain');

        // Delete directory with recursive flag
        const deleteResult = await adapter.deleteDirectory(dirPath, true);
        expect(deleteResult).toBe(true);

        // Directory should not exist after deletion
        const existsResult = await adapter.exists(dirPath);
        expect(existsResult).toBe(false);

        // Files should also not exist
        const fileExists = await adapter.exists(filePath);
        const subDirExists = await adapter.exists(subDirPath);
        const subFileExists = await adapter.exists(subFilePath);
        expect(fileExists).toBe(false);
        expect(subDirExists).toBe(false);
        expect(subFileExists).toBe(false);
      });
    });

    // Metadata Operations
    describe('Metadata Operations', () => {
      test('set and get metadata', async () => {
        const path = 'metadata-test.txt';
        const content = 'test content';
        const type = 'text/plain';
        const metadata = { author: 'Test User', version: 1 };

        // Write content
        await adapter.write(path, content, type);

        // Set metadata
        const setResult = await adapter.setMetadata(path, metadata);
        expect(setResult).toBe(true);

        // Get metadata
        const getResult = await adapter.getMetadata(path);
        expect(getResult).not.toBeNull();
        expect(getResult?.author).toBe('Test User');
        expect(getResult?.version).toBe(1);
      });

      test('get metadata for non-existent path returns null', async () => {
        const path = 'non-existent-metadata.txt';
        const getResult = await adapter.getMetadata(path);
        expect(getResult).toBeNull();
      });

      test('update existing metadata', async () => {
        const path = 'update-metadata.txt';
        const content = 'test content';
        const type = 'text/plain';
        const initialMetadata = { author: 'Initial User', version: 1 };
        const updatedMetadata = {
          author: 'Updated User',
          version: 2,
          status: 'complete',
        };

        // Write content and set initial metadata
        await adapter.write(path, content, type);
        await adapter.setMetadata(path, initialMetadata);

        // Update metadata
        const updateResult = await adapter.setMetadata(path, updatedMetadata);
        expect(updateResult).toBe(true);

        // Get updated metadata
        const getResult = await adapter.getMetadata(path);
        expect(getResult).not.toBeNull();
        expect(getResult?.author).toBe('Updated User');
        expect(getResult?.version).toBe(2);
        expect(getResult?.status).toBe('complete');
      });
    });

    // Utility Operations
    describe('Utility Operations', () => {
      test('move file', async () => {
        const sourcePath = 'source-file.txt';
        const destPath = 'dest-file.txt';
        const content = 'test content';
        const type = 'text/plain';

        // Write source file
        await adapter.write(sourcePath, content, type);

        // Move file
        const moveResult = await adapter.move(sourcePath, destPath);
        expect(moveResult).toBe(true);

        // Source should no longer exist
        const sourceExists = await adapter.exists(sourcePath);
        expect(sourceExists).toBe(false);

        // Destination should exist with same content
        const destExists = await adapter.exists(destPath);
        expect(destExists).toBe(true);

        const readResult = await adapter.read(destPath);
        expect(readResult).not.toBeNull();
        expect(readResult?.content).toBe(content);
        expect(readResult?.type).toBe(type);
      });

      test('move directory', async () => {
        const sourceDir = 'source-dir';
        const destDir = 'dest-dir';
        const filePath = `${sourceDir}/file.txt`;
        const content = 'test content';
        const type = 'text/plain';

        // Create source directory and file
        await adapter.createDirectory(sourceDir);
        await adapter.write(filePath, content, type);

        // Move directory
        const moveResult = await adapter.move(sourceDir, destDir);
        expect(moveResult).toBe(true);

        // Source should no longer exist
        const sourceExists = await adapter.exists(sourceDir);
        expect(sourceExists).toBe(false);

        // Destination should exist
        const destExists = await adapter.exists(destDir);
        expect(destExists).toBe(true);

        // File should be moved to destination
        const destFilePath = `${destDir}/file.txt`;
        const destFileExists = await adapter.exists(destFilePath);
        expect(destFileExists).toBe(true);

        const readResult = await adapter.read(destFilePath);
        expect(readResult).not.toBeNull();
        expect(readResult?.content).toBe(content);
        expect(readResult?.type).toBe(type);
      });

      test('copy file', async () => {
        const sourcePath = 'source-copy-file.txt';
        const destPath = 'dest-copy-file.txt';
        const content = 'test content';
        const type = 'text/plain';

        // Write source file
        await adapter.write(sourcePath, content, type);

        // Copy file
        const copyResult = await adapter.copy(sourcePath, destPath);
        expect(copyResult).toBe(true);

        // Source should still exist
        const sourceExists = await adapter.exists(sourcePath);
        expect(sourceExists).toBe(true);

        // Destination should exist with same content
        const destExists = await adapter.exists(destPath);
        expect(destExists).toBe(true);

        const readResult = await adapter.read(destPath);
        expect(readResult).not.toBeNull();
        expect(readResult?.content).toBe(content);
        expect(readResult?.type).toBe(type);
      });

      test('copy directory', async () => {
        const sourceDir = 'source-copy-dir';
        const destDir = 'dest-copy-dir';
        const filePath = `${sourceDir}/file.txt`;
        const content = 'test content';
        const type = 'text/plain';

        // Create source directory and file
        await adapter.createDirectory(sourceDir);
        await adapter.write(filePath, content, type);

        // Copy directory
        const copyResult = await adapter.copy(sourceDir, destDir);
        expect(copyResult).toBe(true);

        // Source should still exist
        const sourceExists = await adapter.exists(sourceDir);
        expect(sourceExists).toBe(true);

        // Destination should exist
        const destExists = await adapter.exists(destDir);
        expect(destExists).toBe(true);

        // File should be copied to destination
        const destFilePath = `${destDir}/file.txt`;
        const destFileExists = await adapter.exists(destFilePath);
        expect(destFileExists).toBe(true);

        const readResult = await adapter.read(destFilePath);
        expect(readResult).not.toBeNull();
        expect(readResult?.content).toBe(content);
        expect(readResult?.type).toBe(type);
      });

      test('move non-existent source fails', async () => {
        const sourcePath = 'non-existent-source.txt';
        const destPath = 'dest-fail.txt';

        const moveResult = await adapter.move(sourcePath, destPath);
        expect(moveResult).toBe(false);
      });

      test('copy non-existent source fails', async () => {
        const sourcePath = 'non-existent-source-copy.txt';
        const destPath = 'dest-copy-fail.txt';

        const copyResult = await adapter.copy(sourcePath, destPath);
        expect(copyResult).toBe(false);
      });
    });
  });

  return baseTests;
}
