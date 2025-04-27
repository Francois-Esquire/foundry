import type { Database } from "bun:sqlite";

import { calculateHash } from "./utils"; // Import from utils

/**
 * Represents a stored knowledge snippet.
 */
export interface KnowledgeSnippet {
  id: number;
  path: string;
  content: string;
  hash: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Interface for managing knowledge snippets.
 */
export interface KnowledgeStore {
  /**
   * Adds a new knowledge snippet. If content with the same hash already exists,
   * it returns the existing entry's info.
   *
   * @param path - The category path for the knowledge (e.g., 'knowledge/db/sqlite').
   * @param content - The text content of the knowledge snippet.
   * @returns A Promise resolving to an object containing the id, hash, and whether the snippet was newly created.
   */
  add(
    path: string,
    content: string,
  ): Promise<{ id: number; hash: string; created: boolean }>;

  /**
   * Deletes a knowledge snippet by its unique ID.
   * @param id - The ID of the snippet to delete.
   * @returns A Promise resolving to true if a snippet was deleted, false otherwise.
   */
  deleteById(id: number): Promise<boolean>;

  /**
   * Deletes one or more knowledge snippets by their content hash.
   * @param hash - The content hash of the snippet(s) to delete.
   * @returns A Promise resolving to true if at least one snippet was deleted, false otherwise.
   */
  deleteByHash(hash: string): Promise<boolean>;

  /**
   * Retrieves a knowledge snippet by its unique ID.
   * @param id - The ID of the snippet to retrieve.
   * @returns A Promise resolving to the KnowledgeSnippet or null if not found.
   */
  getById(id: number): Promise<KnowledgeSnippet | null>;

  /**
   * Retrieves a knowledge snippet by its content hash.
   * @param hash - The content hash of the snippet to retrieve.
   * @returns A Promise resolving to the KnowledgeSnippet or null if not found.
   */
  getByHash(hash: string): Promise<KnowledgeSnippet | null>;

  /**
   * Finds all knowledge snippets matching a given path prefix.
   * @param pathPrefix - The path prefix to search for (e.g., 'knowledge/db/').
   * @returns A Promise resolving to an array of matching KnowledgeSnippets.
   */
  findByPathPrefix(pathPrefix: string): Promise<KnowledgeSnippet[]>;
}

/**
 * Creates a new KnowledgeStore instance.
 * @param db - The bun:sqlite Database instance.
 * @returns A KnowledgeStore object.
 */
export function createKnowledgeStore(db: Database): KnowledgeStore {
  // Prepare statements for efficiency
  const addStmt = db.prepare(
    "INSERT OR IGNORE INTO knowledge_store (path, content, content_hash) VALUES (?, ?, ?)",
  );
  const findByHashStmt = db.prepare(
    "SELECT id, path, content, content_hash, created_at, updated_at FROM knowledge_store WHERE content_hash = ?",
  );
  const findByIdStmt = db.prepare(
    "SELECT id, path, content, content_hash, created_at, updated_at FROM knowledge_store WHERE id = ?",
  );
  const deleteByIdStmt = db.prepare("DELETE FROM knowledge_store WHERE id = ?");
  const deleteByHashStmt = db.prepare(
    "DELETE FROM knowledge_store WHERE content_hash = ?",
  );
  const findByPathPrefixStmt = db.prepare(
    "SELECT id, path, content, content_hash, created_at, updated_at FROM knowledge_store WHERE path LIKE ?",
  );

  function rowToSnippet(row: any): KnowledgeSnippet | null {
    if (!row) return null;
    return {
      id: Number(row.id),
      path: String(row.path),
      content: String(row.content),
      hash: String(row.content_hash),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  return {
    async add(path, content) {
      const hash = calculateHash(content);
      let created = false;
      let id: number | bigint | undefined;

      // Transaction to ensure atomicity of insert and select
      db.transaction(() => {
        const insertResult = addStmt.run(path, content, hash);
        if (insertResult.changes > 0) {
          created = true;
          id = insertResult.lastInsertRowid;
        } else {
          // If ignored, find the existing one by hash
          const existing = findByHashStmt.get(hash) as any;
          id = existing?.id;
        }
      })(); // Immediately invoke the transaction

      if (
        id === undefined ||
        (typeof id !== "number" && typeof id !== "bigint")
      ) {
        throw new Error(
          `Failed to add or find knowledge snippet with hash: ${hash}`,
        );
      }

      return { id: Number(id), hash, created };
    },

    async deleteById(id) {
      const result = deleteByIdStmt.run(id);
      return result.changes > 0;
    },

    async deleteByHash(hash) {
      const result = deleteByHashStmt.run(hash);
      return result.changes > 0;
    },

    async getById(id) {
      const row = findByIdStmt.get(id);
      return rowToSnippet(row);
    },

    async getByHash(hash) {
      const row = findByHashStmt.get(hash);
      return rowToSnippet(row);
    },

    async findByPathPrefix(pathPrefix) {
      const rows = findByPathPrefixStmt.all(pathPrefix + "%") as any[];
      return rows
        .map((row) => rowToSnippet(row))
        .filter((s) => s !== null) as KnowledgeSnippet[];
    },
  };
}
