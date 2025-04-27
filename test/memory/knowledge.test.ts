import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import {
  createMemoryManager,
  type MemoryManager,
  type KnowledgeStore,
  type KnowledgeSnippet,
} from '../../src/memory'; // Import from main index to get manager

describe('KnowledgeStore', () => {
  const MEMORY_DB_PATH = ':memory:';
  let memory: MemoryManager | null = null;
  let knowledge: KnowledgeStore | null = null;

  beforeEach(async () => {
    // Create a fresh memory manager (and thus DB) for each test
    memory = await createMemoryManager(MEMORY_DB_PATH);
    knowledge = memory.knowledge; // Get the knowledge store instance
  });

  afterEach(async () => {
    // Close the main memory manager connection after each test
    if (memory) {
      await memory.close();
    }
    memory = null;
    knowledge = null;
  });

  test('should add a new unique snippet', async () => {
    expect(knowledge).not.toBeNull();
    const path = 'knowledge/test/add';
    const content = 'This is the first snippet.';
    const result = await knowledge!.add(path, content);

    expect(result.id).toBeGreaterThan(0);
    expect(result.created).toBe(true);
    expect(result.hash).toBeDefined();

    // Verify retrieval
    const retrieved = await knowledge!.getById(result.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.path).toBe(path);
    expect(retrieved?.content).toBe(content);
    expect(retrieved?.hash).toBe(result.hash);
  });

  test('should not create a new snippet if content hash exists', async () => {
    expect(knowledge).not.toBeNull();
    const path1 = 'knowledge/test/duplicate';
    const path2 = 'knowledge/other/path';
    const content = 'This content will be added twice.';

    // Add first time
    const result1 = await knowledge!.add(path1, content);
    expect(result1.created).toBe(true);

    // Add second time (same content, different path)
    const result2 = await knowledge!.add(path2, content);
    expect(result2.created).toBe(false); // Should not be newly created
    expect(result2.id).toBe(result1.id); // Should have the same ID
    expect(result2.hash).toBe(result1.hash); // Should have the same hash

    // Verify only one entry exists via hash
    const retrieved = await knowledge!.getByHash(result1.hash);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe(result1.id);
    // Note: The path stored will be from the *first* insertion due to INSERT OR IGNORE
    expect(retrieved?.path).toBe(path1);
  });

  test('should add different snippets under the same path', async () => {
    expect(knowledge).not.toBeNull();
    const path = 'knowledge/test/multi';
    const content1 = 'First content under multi.';
    const content2 = 'Second content under multi.';

    const result1 = await knowledge!.add(path, content1);
    const result2 = await knowledge!.add(path, content2);

    expect(result1.created).toBe(true);
    expect(result2.created).toBe(true);
    expect(result1.id).not.toBe(result2.id);
    expect(result1.hash).not.toBe(result2.hash);

    const retrieved1 = await knowledge!.getById(result1.id);
    const retrieved2 = await knowledge!.getById(result2.id);
    expect(retrieved1?.path).toBe(path);
    expect(retrieved1?.content).toBe(content1);
    expect(retrieved2?.path).toBe(path);
    expect(retrieved2?.content).toBe(content2);
  });

  test('should retrieve snippet by ID', async () => {
    expect(knowledge).not.toBeNull();
    const path = 'knowledge/test/get';
    const content = 'Content to get by ID.';
    const { id } = await knowledge!.add(path, content);

    const retrieved = await knowledge!.getById(id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe(id);
    expect(retrieved?.path).toBe(path);
    expect(retrieved?.content).toBe(content);

    // Test non-existent ID
    const notFound = await knowledge!.getById(99999);
    expect(notFound).toBeNull();
  });

  test('should retrieve snippet by hash', async () => {
    expect(knowledge).not.toBeNull();
    const path = 'knowledge/test/gethash';
    const content = 'Content to get by hash.';
    const { hash } = await knowledge!.add(path, content);

    const retrieved = await knowledge!.getByHash(hash);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.hash).toBe(hash);
    expect(retrieved?.path).toBe(path);
    expect(retrieved?.content).toBe(content);

    // Test non-existent hash
    const notFound = await knowledge!.getByHash('nonexistenthash');
    expect(notFound).toBeNull();
  });

  test('should find snippets by path prefix', async () => {
    expect(knowledge).not.toBeNull();
    await knowledge!.add('knowledge/db/sqlite/basics', 'SQLite basics content');
    await knowledge!.add(
      'knowledge/db/sqlite/advanced',
      'SQLite advanced content'
    );
    await knowledge!.add(
      'knowledge/db/postgres/basics',
      'Postgres basics content'
    );
    await knowledge!.add('knowledge/frontend/react', 'React content');

    // Find specific prefix
    const sqliteResults = await knowledge!.findByPathPrefix(
      'knowledge/db/sqlite/'
    );
    expect(sqliteResults.length).toBe(2);
    expect(
      sqliteResults.some(
        (s: KnowledgeSnippet) => s.path === 'knowledge/db/sqlite/basics'
      )
    ).toBe(true);
    expect(
      sqliteResults.some(
        (s: KnowledgeSnippet) => s.path === 'knowledge/db/sqlite/advanced'
      )
    ).toBe(true);

    // Find broader prefix
    const dbResults = await knowledge!.findByPathPrefix('knowledge/db/');
    expect(dbResults.length).toBe(3);
    expect(
      dbResults.some((s: KnowledgeSnippet) =>
        s.path.startsWith('knowledge/db/sqlite')
      )
    ).toBe(true);
    expect(
      dbResults.some((s: KnowledgeSnippet) =>
        s.path.startsWith('knowledge/db/postgres')
      )
    ).toBe(true);

    // Find root prefix
    const allResults = await knowledge!.findByPathPrefix('knowledge/');
    expect(allResults.length).toBe(4);

    // Find non-matching prefix
    const noResults = await knowledge!.findByPathPrefix('knowledge/backend/');
    expect(noResults.length).toBe(0);
  });

  test('should delete snippet by ID', async () => {
    expect(knowledge).not.toBeNull();
    const { id } = await knowledge!.add(
      'knowledge/delete/id',
      'Content to delete by ID'
    );

    // Verify exists
    expect(await knowledge!.getById(id)).not.toBeNull();

    // Delete
    const deleted = await knowledge!.deleteById(id);
    expect(deleted).toBe(true);

    // Verify deleted
    expect(await knowledge!.getById(id)).toBeNull();

    // Try deleting again
    const deletedAgain = await knowledge!.deleteById(id);
    expect(deletedAgain).toBe(false);
  });

  test('should delete snippet by hash', async () => {
    expect(knowledge).not.toBeNull();
    const content = 'Content to delete by hash';
    const { hash } = await knowledge!.add('knowledge/delete/hash', content);

    // Verify exists
    expect(await knowledge!.getByHash(hash)).not.toBeNull();

    // Delete
    const deleted = await knowledge!.deleteByHash(hash);
    expect(deleted).toBe(true);

    // Verify deleted
    expect(await knowledge!.getByHash(hash)).toBeNull();

    // Try deleting again
    const deletedAgain = await knowledge!.deleteByHash(hash);
    expect(deletedAgain).toBe(false);
  });
});
