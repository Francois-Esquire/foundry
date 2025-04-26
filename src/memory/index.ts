// memory/index.ts
import fs, { Dirent } from 'node:fs';
import { Database } from 'bun:sqlite';
import { cosineSimilarity } from 'ai';
import crypto from 'crypto';
import { embed as localEmbed } from './embeddings';
// Import types separately when verbatimModuleSyntax is enabled
import type { TraverseOptions } from './fs';
import { traverseDirectory, processSingleFile } from './fs';
import { extname } from 'node:path'; // Import extname
// Import KnowledgeStore related types and functions
import type { KnowledgeStore, KnowledgeSnippet } from './knowledge';
import { createKnowledgeStore } from './knowledge';
import { calculateHash } from './utils'; // Import from utils

// Define embedding dimension constant
const EMBEDDING_DIMENSION = 512;

/**
 * SQL queries used by the memory manager
 */
const queries = {
  // 1) On-demand import depths
  deps: `
    WITH RECURSIVE
      walk(parent, child, depth) AS (
        -- base: direct imports (depth = 1)
        SELECT parent_id, child_id, 1
          FROM deps
         WHERE parent_id = ?

        UNION ALL

        -- step: follow each child to its own children
        SELECT d.parent_id,
               d.child_id,
               w.depth + 1
          FROM deps d
          JOIN walk w
            ON d.parent_id = w.child
         WHERE w.depth < 50  -- guard against cycles
      )
    SELECT
      w.child   AS file_id,
      f.path    AS path,
      MIN(w.depth) AS depth
      FROM walk w
      JOIN files f ON w.child = f.id
     GROUP BY w.child, f.path
     ORDER BY depth;
  `.trim(),

  // 2) Closure-table lookup (precomputed)
  closure: `
    SELECT
      descendant_id AS file_id,
      depth
    FROM file_closure
    WHERE ancestor_id = :rootId
    ORDER BY depth;
  `.trim(),

  // 3) Materialized-path filter
  path: `
    SELECT
      id,
      path,
      matpath
    FROM files
    WHERE matpath LIKE :pathPattern;
  `.trim(),

  // 4) JSON-adjacency expansion
  jsonDeps: `
    SELECT
      f.id         AS file_id,
      j.value      AS child_path
    FROM files f,
         json_each(f.deps_json) AS j
    WHERE j.value = :depPath;
  `.trim(),

  // 5) Combined: path + JSON deps + vector threshold
  combined: `
    WITH
      filtered_paths AS (
        SELECT * FROM files
         WHERE matpath LIKE @pathPattern
      ),
      filtered_deps AS (
        SELECT fp.*
          FROM filtered_paths AS fp,
               json_each(fp.deps_json) AS j
         WHERE j.value = @depPath
      )
    SELECT
      fd.id,
      fd.path,
      cosine_sim(fd.embedding_json, @emb) AS score -- Note: cosine_sim likely needs JS implementation
    FROM filtered_deps AS fd
    WHERE score > @minScore
    ORDER BY score DESC
    LIMIT @limit;
  `.trim(),

  // Add query for retrieving chunks by file path
  chunksByFile: `
    SELECT 
      file_path, 
      start_line, 
      end_line, 
      chunk_hash, 
      embedding_json
    FROM chunk_cache
    WHERE file_path = ?
    ORDER BY start_line;
  `.trim(),

  // Add query for retrieving chunks by line range
  chunksByRange: `
    SELECT 
      file_path, 
      start_line, 
      end_line, 
      chunk_hash, 
      embedding_json
    FROM chunk_cache
    WHERE file_path = ?
      AND NOT (end_line < ? OR start_line > ?)
    ORDER BY start_line;
  `.trim(),
};

/**
 * Initialize database schema and settings
 */
function initializeDatabase(db: Database): void {
  db.exec(
    `
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `.trim()
  );

  db.exec(
    `
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      content TEXT,
      deps_json TEXT,
      embedding_json TEXT,
      matpath TEXT,
      content_hash TEXT,
      last_indexed INTEGER
    );
    
    CREATE TABLE IF NOT EXISTS deps (
      parent_id INTEGER,
      child_id INTEGER,
      PRIMARY KEY (parent_id, child_id),
      FOREIGN KEY (parent_id) REFERENCES files(id) ON DELETE CASCADE, -- Cascade deletes
      FOREIGN KEY (child_id) REFERENCES files(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chunk_cache (
      file_path    TEXT    NOT NULL,
      start_line   INTEGER NOT NULL,
      end_line     INTEGER NOT NULL,
      chunk_hash   TEXT    PRIMARY KEY,
      embedding_json TEXT   NOT NULL,
      created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_chunk_file_path ON chunk_cache(file_path);
    CREATE INDEX IF NOT EXISTS idx_chunk_lines ON chunk_cache(file_path, start_line, end_line);

    -- NEW: Knowledge Store Table
    CREATE TABLE IF NOT EXISTS knowledge_store (
      id           INTEGER PRIMARY KEY,
      path         TEXT    NOT NULL,      -- Category path (e.g., knowledge/frontend/react/hooks)
      content      TEXT    NOT NULL,      -- The actual knowledge snippet
      content_hash TEXT    NOT NULL UNIQUE, -- Hash of the content for uniqueness
      created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_path ON knowledge_store(path);
    CREATE INDEX IF NOT EXISTS idx_knowledge_hash ON knowledge_store(content_hash);

    -- NEW: Trigger to update updated_at for knowledge_store
    CREATE TRIGGER IF NOT EXISTS trigger_knowledge_store_updated_at
    AFTER UPDATE ON knowledge_store
    FOR EACH ROW
    BEGIN
        UPDATE knowledge_store SET updated_at = strftime('%s','now') WHERE id = OLD.id;
    END;

  `.trim()
  );
}

/**
 * Represents a chunk of a file
 */
export interface FileChunk {
  text: string;
  startLine: number;
  endLine: number;
}

/**
 * Represents a cached chunk with embedding
 */
export interface CachedChunk {
  filePath: string;
  startLine: number;
  endLine: number;
  hash: string;
  embedding: number[];
}

/**
 * Memory Manager for file introspection and relationship querying
 */
export interface MemoryManager {
  /**
   * Find files related to a specific file by dependencies
   */
  findRelatedFiles(
    filePath: string,
    depth?: number
  ): Promise<Array<{ id: number; path: string; depth: number }>>;

  /**
   * Find files similar to the query text using vector similarity
   */
  findSimilarFiles(params: {
    query: string;
    pathPattern?: string;
    minScore?: number;
    limit?: number;
  }): Promise<Array<{ id: number; path: string; score: number }>>;

  /**
   * Add or update a file in the memory database
   */
  addFile(params: {
    path: string;
    content: string;
    dependencies: string[];
  }): Promise<number>;

  /**
   * Get file metadata by path
   */
  getFile(path: string): Promise<{
    id: number;
    path: string;
    content: string;
    dependencies: string[];
  } | null>;

  /**
   * Process a file into chunks and generate embeddings
   */
  processFileChunks(
    filePath: string,
    content: string,
    options?: {
      maxLines?: number;
      overlap?: number;
    }
  ): Promise<CachedChunk[]>;

  /**
   * Get all cached chunks for a file
   */
  getFileChunks(filePath: string): Promise<CachedChunk[]>;

  /**
   * Invalidate chunks for a file
   */
  invalidateFile(filePath: string): Promise<void>;

  /**
   * Invalidate chunks for a specific line range in a file
   */
  invalidateRange(
    filePath: string,
    startLine: number,
    endLine: number
  ): Promise<void>;

  /**
   * Find similar chunks based on semantic search
   */
  findSimilarChunks(
    query: string,
    options?: {
      filePath?: string;
      limit?: number;
      minScore?: number;
    }
  ): Promise<
    Array<{
      chunk: CachedChunk;
      score: number;
    }>
  >;

  /**
   * Processes a directory recursively: filters files, reads them,
   * chunks them, generates embeddings, and caches the chunks.
   *
   * @param directoryPath The absolute path to the directory to process.
   * @param options Optional filtering options for traversal.
   * @returns A Promise resolving to a Map where keys are processed file paths
   *          and values are the arrays of cached chunks for that file.
   */
  processDirectory(
    directoryPath: string,
    options?: TraverseOptions
  ): Promise<Map<string, CachedChunk[]>>;

  /**
   * Provides access to the knowledge snippet storage and retrieval methods.
   */
  knowledge: KnowledgeStore;

  /**
   * Close the database connection
   */
  close(): void;
}

// --- Start Specialized Query Functions ---

type DbRow = Record<string, any>;

async function queryDeps(
  db: Database,
  rootId: number
): Promise<Array<{ id: number; path: string; depth: number }>> {
  console.log(
    `[queryDeps] Querying with rootId: ${rootId} (type: ${typeof rootId})`
  );
  const results = db.query(queries.deps).all(rootId) as DbRow[];
  console.log(
    `[queryDeps] Found ${results.length} related files for rootId: ${rootId}`
  );
  return results.map(row => ({
    id: Number(row.file_id), // Ensure Number type
    path: String(row.path),
    depth: Number(row.depth), // Ensure Number type
  }));
}

async function queryChunksByFile(
  db: Database,
  filePath: string
): Promise<CachedChunk[]> {
  const chunks = db.query(queries.chunksByFile).all(filePath) as DbRow[];
  return chunks.map(row => ({
    filePath: String(row.file_path),
    startLine: Number(row.start_line), // Cast BigInt to Number
    endLine: Number(row.end_line), // Cast BigInt to Number
    hash: String(row.chunk_hash),
    embedding: JSON.parse(String(row.embedding_json)),
  }));
}

async function queryAllChunks(db: Database): Promise<CachedChunk[]> {
  const chunks = db
    .query(
      `SELECT file_path, start_line, end_line, chunk_hash, embedding_json FROM chunk_cache`
    )
    .all() as DbRow[];
  return chunks.map(row => ({
    filePath: String(row.file_path),
    startLine: Number(row.start_line),
    endLine: Number(row.end_line),
    hash: String(row.chunk_hash),
    embedding: JSON.parse(String(row.embedding_json)),
  }));
}

function prepareInsertChunk(db: Database) {
  return db.prepare(`
    INSERT INTO chunk_cache
      (file_path, start_line, end_line, chunk_hash, embedding_json)
    VALUES
      (?, ?, ?, ?, ?)
  `);
}

function prepareCheckChunkExists(db: Database) {
  return db.prepare(`SELECT 1 FROM chunk_cache WHERE chunk_hash = ?`);
}

async function deleteChunksByFile(
  db: Database,
  filePath: string
): Promise<void> {
  db.query(`DELETE FROM chunk_cache WHERE file_path = ?`).run(filePath);
}

async function deleteChunksByRange(
  db: Database,
  filePath: string,
  startLine: number,
  endLine: number
): Promise<void> {
  db.query(
    `DELETE FROM chunk_cache WHERE file_path = ? AND NOT (end_line < ? OR start_line > ?)`
  ).run(filePath, startLine, endLine);
}

// --- End Specialized Query Functions ---

/**
 * Calculate a hash for a chunk of code based on content and location
 */
function hashChunk(
  filePath: string,
  text: string,
  start: number,
  end: number
): string {
  // stringify metadata + content
  const payload = JSON.stringify({ filePath, start, end, text });
  return calculateHash(payload); // Restore call to calculateHash
}

/**
 * Split a text into chunks by lines
 */
function chunkByLines(text: string, maxLines = 50, overlap = 5): FileChunk[] {
  const lines = text.split(/\r?\n/);
  const chunks: FileChunk[] = [];

  for (let i = 0; i < lines.length; i += maxLines - overlap) {
    const slice = lines.slice(i, i + maxLines);
    chunks.push({
      text: slice.join('\n'),
      startLine: i + 1, // 1-based
      endLine: i + slice.length,
    });
  }

  return chunks;
}

/**
 * Create a new memory manager instance
 */
export async function createMemoryManager(
  dbPath: string = ':memory:'
): Promise<MemoryManager> {
  const db = new Database(dbPath, {
    create: true,
    readwrite: true,
    safeIntegers: true, // Keep this for now, handle casting in query functions
  });

  // Initialize the database schema and settings
  initializeDatabase(db);

  // Prepare statements once
  const insertChunkStmt = prepareInsertChunk(db);
  const checkChunkExistsStmt = prepareCheckChunkExists(db);

  // List of text-based extensions to process by default
  const DEFAULT_TEXT_EXTENSIONS = [
    '.js',
    '.ts',
    '.jsx',
    '.tsx',
    '.json',
    '.md',
    '.markdown',
    '.html',
    '.htm',
    '.css',
    '.scss',
    '.less',
    '.py',
    '.java',
    '.c',
    '.cpp',
    '.h',
    '.hpp',
    '.cs',
    '.go',
    '.php',
    '.rb',
    '.rs',
    '.swift',
    '.kt',
    '.sh',
    '.bash',
    '.zsh',
    '.yaml',
    '.yml',
    '.toml',
    '.ini',
    '.xml',
    '.txt',
    '.text',
    // Add other relevant text-based extensions
  ];

  // Create the KnowledgeStore instance
  const knowledgeStore = createKnowledgeStore(db);

  // Implement the memory manager
  const manager: MemoryManager = {
    /**
     * Find files related to a specific file by dependencies
     */
    async findRelatedFiles(filePath: string, depth: number = 3) {
      const fileQuery = db
        .query(`SELECT id FROM files WHERE path = ?`)
        .get(filePath) as { id: number | bigint } | null; // Explicit type

      // Check if fileQuery exists and has a valid id
      if (
        !fileQuery ||
        (typeof fileQuery.id !== 'number' && typeof fileQuery.id !== 'bigint')
      ) {
        console.warn(
          `[findRelatedFiles] File not found or invalid ID for path: ${filePath}`
        );
        return [];
      }
      const fileId = Number(fileQuery.id); // Convert bigint/number to number

      // Use the specialized query function
      const relatedFiles = await queryDeps(db, fileId);

      return relatedFiles.filter((item: any) => item.depth <= depth);
    },

    /**
     * Find files similar to the query text using vector similarity
     */
    async findSimilarFiles({
      query,
      pathPattern = '%',
      minScore = 0.7,
      limit = 20,
    }) {
      const [embedding = new Array(EMBEDDING_DIMENSION).fill(0)] =
        await localEmbed([query]);
      const candidates = db
        .query(`SELECT id, path, embedding_json FROM files WHERE path LIKE ?`)
        .all(pathPattern) as DbRow[];

      const results = candidates
        .map((row: any) => {
          const fileEmbedding = JSON.parse(row.embedding_json || '[]');
          const score = cosineSimilarity(embedding, fileEmbedding);
          return {
            id: Number(row.id),
            path: String(row.path),
            score,
          };
        })
        .filter(item => item.score > minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      return results;
    },

    /**
     * Add or update a file in the memory database
     */
    async addFile({ path, content, dependencies }) {
      const embeddings = await localEmbed([content]);
      const embedding =
        embeddings?.[0] || new Array(EMBEDDING_DIMENSION).fill(0);
      const contentHash = calculateHash(content); // Restore call to calculateHash
      const currentTime = Math.floor(Date.now() / 1000);

      const existing = db
        .query(`SELECT id, content_hash FROM files WHERE path = ?`)
        .get(path) as {
        id: number | bigint;
        content_hash: string | null;
      } | null;

      let fileId: number;

      if (existing?.id) {
        fileId = Number(existing.id);
        // Only update if content hash has changed
        if (existing.content_hash !== contentHash) {
          console.log(`[addFile] Content changed for ${path}. Updating.`);
          db.query(
            `UPDATE files SET content = ?, deps_json = ?, embedding_json = ?, content_hash = ?, last_indexed = ? WHERE id = ?`
          ).run(
            content,
            JSON.stringify(dependencies),
            JSON.stringify(embedding),
            contentHash,
            currentTime,
            fileId
          );
          // We might still want to update dependencies even if content is the same?
          // For now, let's clear/re-add deps only when content changes.
          db.query(`DELETE FROM deps WHERE parent_id = ?`).run(fileId);
        } else {
          console.log(
            `[addFile] Content unchanged for ${path}. Skipping content update.`
          );
          // Optionally update dependencies even if content is same?
          // db.query(`DELETE FROM deps WHERE parent_id = ?`).run(fileId);
        }
      } else {
        console.log(`[addFile] Adding new file: ${path}`);
        const result = db
          .query(
            `INSERT INTO files (path, content, deps_json, embedding_json, matpath, content_hash, last_indexed) VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            path,
            content,
            JSON.stringify(dependencies),
            JSON.stringify(embedding),
            path.replace(/\//g, '.'),
            contentHash,
            currentTime
          );
        fileId = Number((result as any).lastInsertRowid);
      }

      if (isNaN(fileId)) {
        console.error(`[addFile] Failed to get valid fileId for path: ${path}`);
        throw new Error(
          `[addFile] Failed to get valid fileId for path: ${path}`
        );
      }

      // --- Dependency Handling (Consider if this should always run) ---
      // Currently runs only if file is new or content hash changed (due to placement)
      // If we need to update deps even if content hash is same, move this block outside the if/else
      // and potentially modify the DELETE logic above.
      for (const depPath of dependencies) {
        const depFile = db
          .query(`SELECT id FROM files WHERE path = ?`)
          .get(depPath) as { id: number | bigint } | null;
        if (depFile?.id) {
          const depId = Number(depFile.id);
          console.log(
            `[addFile] Adding dependency: parent=${fileId} (type: ${typeof fileId}), child=${depId} (type: ${typeof depId})`
          );
          db.query(
            `INSERT OR IGNORE INTO deps (parent_id, child_id) VALUES (?, ?)`
          ).run(fileId, depId);
        } else {
          console.warn(
            `[addFile] Dependency file not found: ${depPath} for parent ${path}`
          );
        }
      }
      return fileId;
    },

    /**
     * Get file metadata by path
     */
    async getFile(path) {
      const result = db
        .query(`SELECT id, path, content, deps_json FROM files WHERE path = ?`)
        .get(path) as DbRow | null;
      if (!result) return null;
      return {
        id: Number(result.id),
        path: String(result.path),
        content: String(result.content),
        dependencies: JSON.parse(String(result.deps_json || '[]')),
      };
    },

    /**
     * Process a file into chunks and generate embeddings
     */
    async processFileChunks(filePath: string, content: string, options = {}) {
      const maxLines = options.maxLines ?? 50;
      const overlap = options.overlap ?? 5;
      const fileChunks = chunkByLines(content, maxLines, overlap);
      const pendingChunks: Array<{
        file_path: string;
        start: number;
        end: number;
        hash: string;
        text: string;
      }> = [];

      for (const { text, startLine, endLine } of fileChunks) {
        const hash = hashChunk(filePath, text, startLine, endLine);
        const exists = checkChunkExistsStmt.get(hash);
        if (!exists) {
          pendingChunks.push({
            file_path: filePath,
            start: startLine,
            end: endLine,
            hash,
            text,
          });
        }
      }

      if (pendingChunks.length === 0) {
        return this.getFileChunks(filePath);
      }

      const chunkTexts = pendingChunks.map(chunk => chunk.text);
      const embeddings = await localEmbed(chunkTexts);

      db.transaction(
        (
          chunksToInsert: typeof pendingChunks,
          embeddingsToInsert: number[][]
        ) => {
          for (let i = 0; i < chunksToInsert.length; i++) {
            const chunk = chunksToInsert[i];
            const embedding = embeddingsToInsert?.[i];
            if (chunk && embedding) {
              insertChunkStmt.run(
                chunk.file_path,
                chunk.start,
                chunk.end,
                chunk.hash,
                JSON.stringify(embedding)
              );
            }
          }
        }
      )(pendingChunks, embeddings);

      return this.getFileChunks(filePath);
    },

    /**
     * Get all cached chunks for a file
     */
    async getFileChunks(filePath: string): Promise<CachedChunk[]> {
      // Use the specialized query function
      return queryChunksByFile(db, filePath);
    },

    /**
     * Invalidate chunks for a file
     */
    async invalidateFile(filePath: string): Promise<void> {
      // Use the specialized delete function
      await deleteChunksByFile(db, filePath);
    },

    /**
     * Invalidate chunks for a specific line range in a file
     */
    async invalidateRange(
      filePath: string,
      startLine: number,
      endLine: number
    ): Promise<void> {
      // Use the specialized delete function
      await deleteChunksByRange(db, filePath, startLine, endLine);
    },

    /**
     * Find similar chunks based on semantic search
     */
    async findSimilarChunks(
      query: string,
      options = {}
    ): Promise<Array<{ chunk: CachedChunk; score: number }>> {
      const { filePath, limit = 10, minScore = 0.7 } = options;
      const [queryEmbedding = new Array(EMBEDDING_DIMENSION).fill(0)] =
        await localEmbed([query]);
      console.log(`[findSimilarChunks] Query: "${query}"`);
      console.log(
        `[findSimilarChunks] Query Embedding Length: ${queryEmbedding?.length}`
      );
      // console.log(`[findSimilarChunks] Query Embedding (first 5): ${queryEmbedding?.slice(0, 5)}`); // Optional: log partial embedding

      // 2. Get candidate chunks
      let chunks: CachedChunk[];
      if (filePath) {
        chunks = await queryChunksByFile(db, filePath);
      } else {
        chunks = await queryAllChunks(db);
      }

      // 3. Calculate scores and filter
      const scoredResults = chunks.map((chunk: CachedChunk) => {
        const score = cosineSimilarity(queryEmbedding, chunk.embedding);
        // Log individual chunk scores before filtering
        console.log(
          `[findSimilarChunks] Chunk (${chunk.filePath}:${chunk.startLine}-${
            chunk.endLine
          }) Score: ${score.toFixed(4)}`
        );
        return { chunk, score };
      });

      const results = scoredResults
        .filter(item => item.score >= minScore) // Filter by minScore (0.7)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit); // Limit results

      return results;
    },

    /**
     * Processes a directory recursively: filters files, reads them,
     * chunks them, generates embeddings, and caches the chunks.
     */
    async processDirectory(
      directoryPath: string,
      options: TraverseOptions = {}
    ): Promise<Map<string, CachedChunk[]>> {
      // Define the transform function to process file content into chunks
      const transformFn = async (
        filePath: string,
        content: string
      ): Promise<CachedChunk[] | null | undefined> => {
        console.log(`[processDirectory] Processing file: ${filePath}`);
        // Use the manager's processFileChunks method
        // Need to ensure `this` context is correct or pass manager instance
        return await this.processFileChunks(filePath, content);
      };

      // Define a filter function to include only text-based files by default
      const filterFn = async (
        filePath: string,
        entry: Dirent
      ): Promise<boolean> => {
        const extension = extname(filePath).toLowerCase();
        // Prioritize options.allowedExtensions if provided
        if (options.allowedExtensions && options.allowedExtensions.length > 0) {
          return options.allowedExtensions.includes(extension);
        }
        // Otherwise, use default text extensions (and check blocklist)
        const isText = DEFAULT_TEXT_EXTENSIONS.includes(extension);
        const isBlocked =
          options.blockedExtensions?.includes(extension) ?? false;
        return isText && !isBlocked;
      };

      console.log(
        `[processDirectory] Starting traversal for: ${directoryPath}`
      );
      const results = await traverseDirectory<CachedChunk[]>(
        directoryPath,
        transformFn.bind(this), // Bind `this` to ensure correct context for processFileChunks
        options, // Pass user-provided options (primarily for blockedExtensions)
        filterFn // Pass the filter function
      );
      console.log(
        `[processDirectory] Traversal complete. Processed ${results.size} files.`
      );
      return results;
    },

    /**
     * Provides access to the knowledge snippet storage and retrieval methods.
     */
    knowledge: knowledgeStore,

    /**
     * Close the database connection
     */
    async close() {
      // Dispose prepared statements before closing db
      insertChunkStmt.finalize();
      checkChunkExistsStmt.finalize();
      db.close(); // db.close() is synchronous in bun:sqlite
    },
  };

  return manager;
}
