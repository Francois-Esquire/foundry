// memory/index.ts

import { Database } from 'bun:sqlite';
import { cosineSimilarity } from 'ai';
import crypto from 'crypto';
import { embed as localEmbed } from './embeddings';

export const queries = {
  // 1) On-demand import depths
  deps: `
    WITH RECURSIVE
      walk(parent, child, depth) AS (
        -- base: direct imports (depth = 1)
        SELECT parent_id, child_id, 1
          FROM deps
         WHERE parent_id = :rootId

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
      child   AS file_id,
      MIN(depth) AS depth
      FROM walk
     GROUP BY child
     ORDER BY depth;
  `,

  // 2) Closure-table lookup (precomputed)
  closure: `
    SELECT
      descendant_id AS file_id,
      depth
    FROM file_closure
    WHERE ancestor_id = :rootId
    ORDER BY depth;
  `,

  // 3) Materialized-path filter
  path: `
    SELECT
      id,
      path,
      matpath
    FROM files
    WHERE matpath LIKE :pathPattern;
  `,

  // 4) JSON-adjacency expansion
  jsonDeps: `
    SELECT
      f.id         AS file_id,
      j.value      AS child_path
    FROM files f,
         json_each(f.deps_json) AS j
    WHERE j.value = :depPath;
  `,

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
      cosine_sim(fd.embedding_json, @emb) AS score
    FROM filtered_deps AS fd
    WHERE score > @minScore
    ORDER BY score DESC
    LIMIT @limit;
  `,

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
  `,

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
  `,
};

type QueryParams = {
  pathPattern: string;
  depPath: string;
  queryEmb: number[];
  minScore: number;
  limit: number;
};

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
 * Create a table to store the embedding vectors if it doesn't exist
 */
function initializeDatabase(db: Database): void {
  // Create tables if they don't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      content TEXT,
      deps_json TEXT,  -- JSON array of dependency paths
      embedding_json TEXT, -- JSON string of embedding vector
      matpath TEXT     -- materialized path for hierarchical queries
    );
    
    CREATE TABLE IF NOT EXISTS deps (
      parent_id INTEGER,
      child_id INTEGER,
      PRIMARY KEY (parent_id, child_id),
      FOREIGN KEY (parent_id) REFERENCES files(id),
      FOREIGN KEY (child_id) REFERENCES files(id)
    );
  `);

  // 1) Write-Ahead Logging for concurrency
  //    Allows readers and writers to operate without blocking each other.
  db.exec('PRAGMA journal_mode = WAL');

  // 2) Reasonable fsync behavior
  //    NORMAL is safe in WAL mode and skips some fsyncs for better perf.
  db.exec('PRAGMA synchronous = NORMAL');

  // 3) Enforce foreign-key constraints (off by default)
  db.exec('PRAGMA foreign_keys = ON');

  // 4) Avoid "database is busy" errors under load
  db.exec('PRAGMA busy_timeout = 5000'); // wait up to 5s before throwing
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
   * Close the database connection
   */
  close(): void;
}

/**
 * Create a new memory manager instance
 */
export async function createMemoryManager(
  dbPath: string = 'memory.db'
): Promise<MemoryManager> {
  const db = new Database(dbPath, { create: true });

  // Initialize the database schema and settings
  initializeDatabase(db);

  // Create chunk cache table - split into separate statements
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunk_cache (
      file_path    TEXT    NOT NULL,
      start_line   INTEGER NOT NULL,
      end_line     INTEGER NOT NULL,
      chunk_hash   TEXT    PRIMARY KEY,
      embedding_json TEXT   NOT NULL,
      created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
  `);

  // Create indices in separate statements
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_chunk_file_path ON chunk_cache(file_path);`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_chunk_lines ON chunk_cache(file_path, start_line, end_line);`
  );

  // Instead of trying to create a SQL function, we'll implement cosine similarity in JavaScript
  // SQLite in Bun may not support custom functions the way we were trying to use them

  // Implement the memory manager
  const manager: MemoryManager = {
    /**
     * Find files related to a specific file by dependencies
     */
    async findRelatedFiles(filePath: string, depth: number = 3) {
      // First, get the file ID
      const fileQuery = db
        .query(`SELECT id FROM files WHERE path = ?`)
        .get(filePath);

      if (!fileQuery) {
        return [];
      }

      const fileId = (fileQuery as any).id;

      // Then, get related files using the deps query
      const result = db.query(queries.deps).all({ rootId: fileId });

      return result
        .map((row: any) => ({
          id: row.file_id,
          path: db
            .query(`SELECT path FROM files WHERE id = ?`)
            .get(row.file_id) as any,
          depth: row.depth,
        }))
        .filter((item: any) => item.depth <= depth);
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
      // Generate embedding for the query using local model
      const [embedding = new Array(1536).fill(0)] = await localEmbed([query]);

      // Get candidates matching path pattern
      const candidates = db
        .query(
          `
        SELECT id, path, embedding_json 
        FROM files 
        WHERE path LIKE ?
      `
        )
        .all(pathPattern);

      // Calculate similarity in JavaScript
      const results = candidates
        .map((row: any) => {
          const fileEmbedding = JSON.parse(row.embedding_json || '[]');
          const score = cosineSimilarity(embedding, fileEmbedding);
          return {
            id: row.id,
            path: row.path,
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
      // First, generate embedding for the file content using local model
      const embeddings = await localEmbed([content]);
      // Use the first embedding or a fallback
      const embedding = embeddings?.[0] || new Array(1536).fill(0);

      // Check if file already exists
      const existing = db
        .query(`SELECT id FROM files WHERE path = ?`)
        .get(path);

      if (existing) {
        // Update existing file
        const fileId = (existing as any).id;

        db.query(
          `
          UPDATE files 
          SET content = ?, deps_json = ?, embedding_json = ? 
          WHERE id = ?
        `
        ).run(
          content,
          JSON.stringify(dependencies),
          JSON.stringify(embedding),
          fileId
        );

        // Update dependencies
        db.query(`DELETE FROM deps WHERE parent_id = ?`).run(fileId);

        // Add new dependency relationships
        for (const depPath of dependencies) {
          const depFile = db
            .query(`SELECT id FROM files WHERE path = ?`)
            .get(depPath);

          if (depFile) {
            const depId = (depFile as any).id;
            db.query(
              `INSERT OR IGNORE INTO deps (parent_id, child_id) VALUES (?, ?)`
            ).run(fileId, depId);
          }
        }

        return fileId;
      } else {
        // Insert new file
        const result = db
          .query(
            `
          INSERT INTO files (path, content, deps_json, embedding_json, matpath) 
          VALUES (?, ?, ?, ?, ?)
        `
          )
          .run(
            path,
            content,
            JSON.stringify(dependencies),
            JSON.stringify(embedding),
            path.replace(/\//g, '.') // Simple materialized path
          );

        const fileId = (result as any).lastInsertRowId;

        // Add dependency relationships if deps exist
        for (const depPath of dependencies) {
          const depFile = db
            .query(`SELECT id FROM files WHERE path = ?`)
            .get(depPath);

          if (depFile) {
            const depId = (depFile as any).id;
            db.query(
              `INSERT OR IGNORE INTO deps (parent_id, child_id) VALUES (?, ?)`
            ).run(fileId, depId);
          }
        }

        return fileId;
      }
    },

    /**
     * Get file metadata by path
     */
    async getFile(path) {
      const result = db
        .query(
          `
        SELECT id, path, content, deps_json 
        FROM files 
        WHERE path = ?
      `
        )
        .get(path);

      if (!result) {
        return null;
      }

      return {
        id: (result as any).id,
        path: (result as any).path,
        content: (result as any).content,
        dependencies: JSON.parse((result as any).deps_json || '[]'),
      };
    },

    /**
     * Process a file into chunks and generate embeddings
     */
    async processFileChunks(filePath: string, content: string, options = {}) {
      const maxLines = options.maxLines ?? 50;
      const overlap = options.overlap ?? 5;

      // Split the file into chunks
      const chunks = chunkByLines(content, maxLines, overlap);

      // Prepare data for embedding
      const pendingChunks: Array<{
        file_path: string;
        start: number;
        end: number;
        hash: string;
        text: string;
      }> = [];

      // Check which chunks need embedding
      const insertStmt = db.prepare(`
        INSERT INTO chunk_cache
          (file_path, start_line, end_line, chunk_hash, embedding_json)
        VALUES
          (?, ?, ?, ?, ?)
      `);

      for (const { text, startLine, endLine } of chunks) {
        const hash = hashChunk(filePath, text, startLine, endLine);

        // Check if chunk already exists in cache
        const exists = db
          .query(
            `
          SELECT 1 FROM chunk_cache 
          WHERE chunk_hash = ?
        `
          )
          .get(hash);

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

      // If no new chunks, return existing ones
      if (pendingChunks.length === 0) {
        return this.getFileChunks(filePath);
      }

      // Generate embeddings for new chunks using our local model
      const chunkTexts = pendingChunks.map(chunk => chunk.text);
      const embeddings = await localEmbed(chunkTexts);

      // Store chunks with embeddings in the database
      db.transaction(() => {
        for (let i = 0; i < pendingChunks.length; i++) {
          const chunk = pendingChunks[i];
          // Ensure we have a valid embedding for this chunk
          const embedding = embeddings?.[i];

          if (chunk && embedding) {
            insertStmt.run(
              chunk.file_path,
              chunk.start,
              chunk.end,
              chunk.hash,
              JSON.stringify(embedding)
            );
          }
        }
      })();

      // Return all chunks for the file
      return this.getFileChunks(filePath);
    },

    /**
     * Get all cached chunks for a file
     */
    async getFileChunks(filePath: string): Promise<CachedChunk[]> {
      const chunks = db.query(queries.chunksByFile).all(filePath);

      return chunks.map((row: any) => ({
        filePath: row.file_path,
        startLine: row.start_line,
        endLine: row.end_line,
        hash: row.chunk_hash,
        embedding: JSON.parse(row.embedding_json),
      }));
    },

    /**
     * Invalidate chunks for a file
     */
    async invalidateFile(filePath: string): Promise<void> {
      db.query(
        `
        DELETE FROM chunk_cache 
        WHERE file_path = ?
      `
      ).run(filePath);
    },

    /**
     * Invalidate chunks for a specific line range in a file
     */
    async invalidateRange(
      filePath: string,
      startLine: number,
      endLine: number
    ): Promise<void> {
      db.query(
        `
        DELETE FROM chunk_cache 
        WHERE file_path = ?
          AND NOT (end_line < ? OR start_line > ?)
      `
      ).run(filePath, startLine, endLine);
    },

    /**
     * Find similar chunks based on semantic search
     */
    async findSimilarChunks(
      query: string,
      options = {}
    ): Promise<Array<{ chunk: CachedChunk; score: number }>> {
      const { filePath, limit = 10, minScore = 0.7 } = options;

      // Generate embedding for query using local model
      const queryEmbeddings = await localEmbed([query]);
      // Ensure we have a valid embedding, using an empty array as fallback
      const queryEmbedding = queryEmbeddings?.[0] || new Array(1536).fill(0);

      // Get chunks to compare against
      let chunks;
      if (filePath) {
        chunks = db
          .query(
            `
          SELECT file_path, start_line, end_line, chunk_hash, embedding_json
          FROM chunk_cache
          WHERE file_path = ?
        `
          )
          .all(filePath);
      } else {
        chunks = db
          .query(
            `
          SELECT file_path, start_line, end_line, chunk_hash, embedding_json
          FROM chunk_cache
        `
          )
          .all();
      }

      // Calculate similarity scores using cosine similarity
      const results = chunks
        .map((row: any) => {
          const chunkEmbedding = JSON.parse(row.embedding_json);
          const score = cosineSimilarity(queryEmbedding, chunkEmbedding);

          return {
            chunk: {
              filePath: row.file_path,
              startLine: row.start_line,
              endLine: row.end_line,
              hash: row.chunk_hash,
              embedding: chunkEmbedding,
            },
            score,
          };
        })
        .filter(item => item.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      return results;
    },

    /**
     * Close the database connection
     */
    close() {
      db.close();
    },
  };

  return manager;
}

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
  return crypto.createHash('sha256').update(payload).digest('hex');
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

// // Example usage with chunking
// async function main() {
//   const memory = await createMemoryManager();

//   // Add files using chunking
//   const fileContent = `
// // Example file with multiple lines
// export function readFile(path: string) {
//   return Bun.file(path).text();
// }

// export function writeFile(path: string, content: string) {
//   return Bun.write(path, content);
// }

// // Some more content to create multiple chunks
// export function appendFile(path: string, content: string) {
//   const file = Bun.file(path);
//   const existing = await file.text();
//   return Bun.write(path, existing + content);
// }
//   `.trim();

//   // Process file with chunking strategy
//   const chunks = await memory.processFileChunks(
//     '/src/utils/io.ts',
//     fileContent
//   );
//   console.log(`File processed into ${chunks.length} chunks`);

//   // Find chunks similar to a query
//   const similarChunks = await memory.findSimilarChunks(
//     'append content to a file'
//   );
//   console.log(
//     'Similar chunks:',
//     similarChunks.map(r => ({
//       filePath: r.chunk.filePath,
//       lines: `${r.chunk.startLine}-${r.chunk.endLine}`,
//       score: r.score,
//     }))
//   );

//   // Invalidate part of a file
//   await memory.invalidateRange('/src/utils/io.ts', 10, 15);
//   console.log('Invalidated lines 10-15');

//   // Reprocess after changes
//   const updatedContent = fileContent + '\n\n// Added new functions\n';
//   const updatedChunks = await memory.processFileChunks(
//     '/src/utils/io.ts',
//     updatedContent
//   );
//   console.log(`File reprocessed into ${updatedChunks.length} chunks`);

//   memory.close();
// }

// // Only run if executed directly
// if (import.meta.path === Bun.main) {
//   main().catch(console.error);
// }
