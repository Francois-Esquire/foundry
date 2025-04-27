import * as path from "path";

import { Database } from "bun:sqlite";

import type { Adapter } from "./types";

/**
 * Constants for the SQLite adapter
 */
const PATH_DELIMITER = "/";
const TABLE_PREFIX = "foundry_fs_"; // 'fs' namespace for file system tables

/**
 * SQLiteAdapter stores data in an SQLite database.
 * - Maps hierarchical paths to a relational database model
 * - Stores content and metadata in separate tables
 * - Maintains directory structure in a dedicated table
 */
export class SQLiteAdapter implements Adapter {
  private db: Database;
  private initialized: boolean = false;

  /**
   * Creates a new SQLiteAdapter
   * @param options Configuration options
   * @param options.databasePath Path to the SQLite database file
   */
  constructor(options: { databasePath: string }) {
    this.db = new Database(options.databasePath);
    this._initializeDatabase();
  }

  /**
   * Reads content and type from the database
   * @param path Path to the resource
   * @returns Object containing content and type, or null if not found
   */
  async read(path: string): Promise<{ content: string; type: string } | null> {
    try {
      const result = this.db
        .query(
          `SELECT content, type FROM ${TABLE_PREFIX}content WHERE path = ?`,
        )
        .get(path) as { content: string; type: string } | undefined;

      return result || null;
    } catch (error) {
      console.error(`Error reading from path ${path}:`, error);
      return null;
    }
  }

  /**
   * Writes content to the database
   * @param path Path to the resource
   * @param content Content to write
   * @param type Content type
   * @returns True if successful
   */
  async write(path: string, content: string, type: string): Promise<boolean> {
    try {
      // Create parent directories if needed
      const dirPath = this.getDirPath(path);
      if (dirPath && !(await this.exists(dirPath))) {
        await this.createDirectory(dirPath);
      }

      // Begin transaction
      const transaction = this.db.transaction(() => {
        // Check if the path already exists
        const exists = this.db
          .query(`SELECT 1 FROM ${TABLE_PREFIX}content WHERE path = ?`)
          .get(path);

        if (exists) {
          // Update existing content
          this.db
            .query(
              `UPDATE ${TABLE_PREFIX}content SET content = ?, type = ? WHERE path = ?`,
            )
            .run(content, type, path);
        } else {
          // Insert new content
          this.db
            .query(
              `INSERT INTO ${TABLE_PREFIX}content (path, content, type) VALUES (?, ?, ?)`,
            )
            .run(path, content, type);
        }
      });

      // Execute transaction
      transaction();
      return true;
    } catch (error) {
      console.error(`Error writing to path ${path}:`, error);
      return false;
    }
  }

  /**
   * Deletes a resource from the database
   * @param path Path to the resource
   * @returns True if successful
   */
  async delete(path: string): Promise<boolean> {
    try {
      if (!(await this.exists(path))) {
        return false;
      }

      // Begin transaction
      const transaction = this.db.transaction(() => {
        // Delete content
        this.db
          .query(`DELETE FROM ${TABLE_PREFIX}content WHERE path = ?`)
          .run(path);

        // Delete metadata if it exists
        this.db
          .query(`DELETE FROM ${TABLE_PREFIX}metadata WHERE path = ?`)
          .run(path);
      });

      // Execute transaction
      transaction();
      return true;
    } catch (error) {
      console.error(`Error deleting path ${path}:`, error);
      return false;
    }
  }

  /**
   * Checks if a resource exists in the database
   * @param path Path to check
   * @returns True if the path exists
   */
  async exists(path: string): Promise<boolean> {
    try {
      // Check content table
      const contentExists = this.db
        .query(`SELECT 1 FROM ${TABLE_PREFIX}content WHERE path = ?`)
        .get(path);

      if (contentExists) return true;

      // Check directories table
      const dirExists = this.db
        .query(`SELECT 1 FROM ${TABLE_PREFIX}directories WHERE path = ?`)
        .get(path);

      return !!dirExists;
    } catch (error) {
      console.error(`Error checking existence of path ${path}:`, error);
      return false;
    }
  }

  /**
   * Lists resources at a path
   * @param path Directory path to list
   * @returns Array of resource names
   */
  async list(path: string): Promise<string[]> {
    try {
      const result: string[] = [];
      const prefix = path.endsWith(PATH_DELIMITER)
        ? path
        : path + PATH_DELIMITER;

      // Check if the directory exists (except for root)
      if (
        path !== "" &&
        path !== PATH_DELIMITER &&
        !(await this.exists(path))
      ) {
        return [];
      }

      // Query for content entries
      const contentPaths = this.db
        .query(
          `SELECT path FROM ${TABLE_PREFIX}content WHERE path LIKE ? AND path NOT LIKE ?`,
        )
        .all(prefix + "%", prefix + "%" + PATH_DELIMITER + "%") as {
        path: string;
      }[];

      // Query for directory entries
      const dirPaths = this.db
        .query(
          `SELECT path FROM ${TABLE_PREFIX}directories WHERE path LIKE ? AND path NOT LIKE ?`,
        )
        .all(prefix + "%", prefix + "%" + PATH_DELIMITER + "%") as {
        path: string;
      }[];

      // Combine results and extract the next segment
      const allPaths = [
        ...contentPaths.map((row) => row.path),
        ...dirPaths.map((row) => row.path),
      ];

      for (const storedPath of allPaths) {
        const relativePath = storedPath.slice(prefix.length);
        const nextSegment = relativePath.split(PATH_DELIMITER)[0];

        if (nextSegment && !result.includes(nextSegment)) {
          result.push(nextSegment);
        }
      }

      return result;
    } catch (error) {
      console.error(`Error listing directory at ${path}:`, error);
      return [];
    }
  }

  /**
   * Creates a directory in the database
   * @param path Directory path to create
   * @returns True if successful
   */
  async createDirectory(path: string): Promise<boolean> {
    try {
      // Create parent directories if needed
      const parentDir = this.getDirPath(path);
      if (parentDir && !(await this.exists(parentDir)) && parentDir !== "") {
        await this.createDirectory(parentDir);
      }

      // Check if directory already exists
      if (await this.exists(path)) {
        return true;
      }

      // Insert directory
      this.db
        .query(`INSERT INTO ${TABLE_PREFIX}directories (path) VALUES (?)`)
        .run(path);

      return true;
    } catch (error) {
      console.error(`Error creating directory at ${path}:`, error);
      return false;
    }
  }

  /**
   * Deletes a directory from the database
   * @param path Directory path to delete
   * @param recursive Whether to delete contents recursively
   * @returns True if successful
   */
  async deleteDirectory(
    path: string,
    recursive: boolean = false,
  ): Promise<boolean> {
    try {
      // Check if directory exists
      const dirExists = this.db
        .query(`SELECT 1 FROM ${TABLE_PREFIX}directories WHERE path = ?`)
        .get(path);

      if (!dirExists) {
        return false;
      }

      const prefix = path.endsWith(PATH_DELIMITER)
        ? path
        : path + PATH_DELIMITER;

      // Check if directory has contents
      const contents = await this.list(path);
      if (contents.length > 0 && !recursive) {
        throw new Error(
          `Directory is not empty: ${path}. Pass recursive=true to delete contents.`,
        );
      }

      // Begin transaction
      const transaction = this.db.transaction(() => {
        // Delete the directory itself
        this.db
          .query(`DELETE FROM ${TABLE_PREFIX}directories WHERE path = ?`)
          .run(path);

        if (recursive) {
          // Delete all content entries that start with the prefix
          this.db
            .query(
              `DELETE FROM ${TABLE_PREFIX}content WHERE path = ? OR path LIKE ?`,
            )
            .run(path, prefix + "%");

          // Delete all metadata entries that start with the prefix
          this.db
            .query(
              `DELETE FROM ${TABLE_PREFIX}metadata WHERE path = ? OR path LIKE ?`,
            )
            .run(path, prefix + "%");

          // Delete all subdirectories
          this.db
            .query(`DELETE FROM ${TABLE_PREFIX}directories WHERE path LIKE ?`)
            .run(prefix + "%");
        }
      });

      // Execute transaction
      transaction();
      return true;
    } catch (error) {
      console.error(`Error deleting directory at ${path}:`, error);
      return false;
    }
  }

  /**
   * Gets metadata for a path
   * @param path Path to get metadata for
   * @returns Metadata object or null if not found
   */
  async getMetadata(path: string): Promise<Record<string, any> | null> {
    try {
      const result = this.db
        .query(`SELECT metadata FROM ${TABLE_PREFIX}metadata WHERE path = ?`)
        .get(path) as { metadata: string } | undefined;

      if (!result) {
        return null;
      }

      return JSON.parse(result.metadata);
    } catch (error) {
      console.error(`Error getting metadata for ${path}:`, error);
      return null;
    }
  }

  /**
   * Sets metadata for a path
   * @param path Path to set metadata for
   * @param metadata Metadata object
   * @returns True if successful
   */
  async setMetadata(
    path: string,
    metadata: Record<string, any>,
  ): Promise<boolean> {
    try {
      const metadataJson = JSON.stringify(metadata);

      // Begin transaction
      const transaction = this.db.transaction(() => {
        // Check if metadata already exists
        const exists = this.db
          .query(`SELECT 1 FROM ${TABLE_PREFIX}metadata WHERE path = ?`)
          .get(path);

        if (exists) {
          // Update existing metadata
          this.db
            .query(
              `UPDATE ${TABLE_PREFIX}metadata SET metadata = ? WHERE path = ?`,
            )
            .run(metadataJson, path);
        } else {
          // Insert new metadata
          this.db
            .query(
              `INSERT INTO ${TABLE_PREFIX}metadata (path, metadata) VALUES (?, ?)`,
            )
            .run(path, metadataJson);
        }
      });

      // Execute transaction
      transaction();
      return true;
    } catch (error) {
      console.error(`Error setting metadata for ${path}:`, error);
      return false;
    }
  }

  /**
   * Moves a resource from one path to another
   * @param sourcePath Source path
   * @param destinationPath Destination path
   * @returns True if successful
   */
  async move(sourcePath: string, destinationPath: string): Promise<boolean> {
    try {
      if (!(await this.exists(sourcePath))) {
        return false;
      }

      // Check if it's a directory
      const isDirectory = this.db
        .query(`SELECT 1 FROM ${TABLE_PREFIX}directories WHERE path = ?`)
        .get(sourcePath);

      let shouldDeleteSourceDirectory = false;

      // Begin transaction
      const transaction = this.db.transaction(() => {
        if (isDirectory) {
          // Set flag to delete source directory after transaction completes
          shouldDeleteSourceDirectory = true;

          // Get all paths that start with the source prefix
          const sourcePrefix = sourcePath.endsWith(PATH_DELIMITER)
            ? sourcePath
            : sourcePath + PATH_DELIMITER;
          const destPrefix = destinationPath.endsWith(PATH_DELIMITER)
            ? destinationPath
            : destinationPath + PATH_DELIMITER;

          // Move all content entries
          const contentEntries = this.db
            .query(
              `SELECT path, content, type FROM ${TABLE_PREFIX}content WHERE path LIKE ?`,
            )
            .all(sourcePrefix + "%") as {
            path: string;
            content: string;
            type: string;
          }[];

          for (const entry of contentEntries) {
            const relativePath = entry.path.slice(sourcePrefix.length);
            const newPath = destPrefix + relativePath;

            // Insert at new path
            this.db
              .query(
                `INSERT INTO ${TABLE_PREFIX}content (path, content, type) VALUES (?, ?, ?)`,
              )
              .run(newPath, entry.content, entry.type);

            // Delete from old path
            this.db
              .query(`DELETE FROM ${TABLE_PREFIX}content WHERE path = ?`)
              .run(entry.path);
          }

          // Move all metadata entries
          const metadataEntries = this.db
            .query(
              `SELECT path, metadata FROM ${TABLE_PREFIX}metadata WHERE path LIKE ?`,
            )
            .all(sourcePrefix + "%") as {
            path: string;
            metadata: string;
          }[];

          for (const entry of metadataEntries) {
            const relativePath = entry.path.slice(sourcePrefix.length);
            const newPath = destPrefix + relativePath;

            // Insert at new path
            this.db
              .query(
                `INSERT INTO ${TABLE_PREFIX}metadata (path, metadata) VALUES (?, ?)`,
              )
              .run(newPath, entry.metadata);

            // Delete from old path
            this.db
              .query(`DELETE FROM ${TABLE_PREFIX}metadata WHERE path = ?`)
              .run(entry.path);
          }

          // Move all subdirectories
          const dirEntries = this.db
            .query(
              `SELECT path FROM ${TABLE_PREFIX}directories WHERE path LIKE ? AND path != ?`,
            )
            .all(sourcePrefix + "%", sourcePath) as {
            path: string;
          }[];

          for (const entry of dirEntries) {
            const relativePath = entry.path.slice(sourcePrefix.length);
            const newPath = destPrefix + relativePath;

            // Insert at new path
            this.db
              .query(`INSERT INTO ${TABLE_PREFIX}directories (path) VALUES (?)`)
              .run(newPath);

            // Delete from old path
            this.db
              .query(`DELETE FROM ${TABLE_PREFIX}directories WHERE path = ?`)
              .run(entry.path);
          }

          // Note: We'll delete the source directory outside the transaction
        } else {
          // It's a file, move the content
          const content = this.db
            .query(
              `SELECT content, type FROM ${TABLE_PREFIX}content WHERE path = ?`,
            )
            .get(sourcePath) as { content: string; type: string } | undefined;

          if (content) {
            // Create parent directory if needed
            const destDirPath = this.getDirPath(destinationPath);
            if (
              destDirPath &&
              !this.db
                .query(
                  `SELECT 1 FROM ${TABLE_PREFIX}directories WHERE path = ?`,
                )
                .get(destDirPath)
            ) {
              // Insert the directory directly - don't use createDirectory which would start another transaction
              this.db
                .query(
                  `INSERT INTO ${TABLE_PREFIX}directories (path) VALUES (?)`,
                )
                .run(destDirPath);
            }

            // Insert at new path
            this.db
              .query(
                `INSERT INTO ${TABLE_PREFIX}content (path, content, type) VALUES (?, ?, ?)`,
              )
              .run(destinationPath, content.content, content.type);

            // Delete from old path
            this.db
              .query(`DELETE FROM ${TABLE_PREFIX}content WHERE path = ?`)
              .run(sourcePath);

            // Move metadata if it exists
            const metadata = this.db
              .query(
                `SELECT metadata FROM ${TABLE_PREFIX}metadata WHERE path = ?`,
              )
              .get(sourcePath) as { metadata: string } | undefined;

            if (metadata) {
              // Insert at new path
              this.db
                .query(
                  `INSERT INTO ${TABLE_PREFIX}metadata (path, metadata) VALUES (?, ?)`,
                )
                .run(destinationPath, metadata.metadata);

              // Delete from old path
              this.db
                .query(`DELETE FROM ${TABLE_PREFIX}metadata WHERE path = ?`)
                .run(sourcePath);
            }
          }
        }
      });

      // Execute transaction
      transaction();

      // Create destination directory for directory moves
      // This needs to happen outside the transaction to avoid nesting transactions
      if (isDirectory) {
        await this.createDirectory(destinationPath);
      }

      // Delete source directory after transaction if it was a directory move
      if (shouldDeleteSourceDirectory) {
        this.db
          .query(`DELETE FROM ${TABLE_PREFIX}directories WHERE path = ?`)
          .run(sourcePath);
      }

      return true;
    } catch (error) {
      console.error(
        `Error moving from ${sourcePath} to ${destinationPath}:`,
        error,
      );
      return false;
    }
  }

  /**
   * Copies a resource from one path to another
   * @param sourcePath Source path
   * @param destinationPath Destination path
   * @returns True if successful
   */
  async copy(sourcePath: string, destinationPath: string): Promise<boolean> {
    try {
      if (!(await this.exists(sourcePath))) {
        return false;
      }

      // Check if it's a directory
      const isDirectory = this.db
        .query(`SELECT 1 FROM ${TABLE_PREFIX}directories WHERE path = ?`)
        .get(sourcePath);

      // Begin transaction
      const transaction = this.db.transaction(async () => {
        if (isDirectory) {
          // Create the destination directory
          await this.createDirectory(destinationPath);

          // Get all paths that start with the source prefix
          const sourcePrefix = sourcePath.endsWith(PATH_DELIMITER)
            ? sourcePath
            : sourcePath + PATH_DELIMITER;
          const destPrefix = destinationPath.endsWith(PATH_DELIMITER)
            ? destinationPath
            : destinationPath + PATH_DELIMITER;

          // Copy all content entries
          const contentEntries = this.db
            .query(
              `SELECT path, content, type FROM ${TABLE_PREFIX}content WHERE path LIKE ?`,
            )
            .all(sourcePrefix + "%") as {
            path: string;
            content: string;
            type: string;
          }[];

          for (const entry of contentEntries) {
            const relativePath = entry.path.slice(sourcePrefix.length);
            const newPath = destPrefix + relativePath;

            // Insert at new path
            this.db
              .query(
                `INSERT INTO ${TABLE_PREFIX}content (path, content, type) VALUES (?, ?, ?)`,
              )
              .run(newPath, entry.content, entry.type);
          }

          // Copy all metadata entries
          const metadataEntries = this.db
            .query(
              `SELECT path, metadata FROM ${TABLE_PREFIX}metadata WHERE path LIKE ?`,
            )
            .all(sourcePrefix + "%") as {
            path: string;
            metadata: string;
          }[];

          for (const entry of metadataEntries) {
            const relativePath = entry.path.slice(sourcePrefix.length);
            const newPath = destPrefix + relativePath;

            // Insert at new path
            this.db
              .query(
                `INSERT INTO ${TABLE_PREFIX}metadata (path, metadata) VALUES (?, ?)`,
              )
              .run(newPath, entry.metadata);
          }

          // Copy all subdirectories
          const dirEntries = this.db
            .query(
              `SELECT path FROM ${TABLE_PREFIX}directories WHERE path LIKE ? AND path != ?`,
            )
            .all(sourcePrefix + "%", sourcePath) as {
            path: string;
          }[];

          for (const entry of dirEntries) {
            const relativePath = entry.path.slice(sourcePrefix.length);
            const newPath = destPrefix + relativePath;

            // Insert at new path
            this.db
              .query(`INSERT INTO ${TABLE_PREFIX}directories (path) VALUES (?)`)
              .run(newPath);
          }
        } else {
          // It's a file, copy the content
          const content = this.db
            .query(
              `SELECT content, type FROM ${TABLE_PREFIX}content WHERE path = ?`,
            )
            .get(sourcePath) as { content: string; type: string } | undefined;

          if (content) {
            // Create parent directory if needed
            const destDirPath = this.getDirPath(destinationPath);
            if (destDirPath && !(await this.exists(destDirPath))) {
              await this.createDirectory(destDirPath);
            }

            // Insert at new path
            this.db
              .query(
                `INSERT INTO ${TABLE_PREFIX}content (path, content, type) VALUES (?, ?, ?)`,
              )
              .run(destinationPath, content.content, content.type);

            // Copy metadata if it exists
            const metadata = this.db
              .query(
                `SELECT metadata FROM ${TABLE_PREFIX}metadata WHERE path = ?`,
              )
              .get(sourcePath) as { metadata: string } | undefined;

            if (metadata) {
              // Insert at new path
              this.db
                .query(
                  `INSERT INTO ${TABLE_PREFIX}metadata (path, metadata) VALUES (?, ?)`,
                )
                .run(destinationPath, metadata.metadata);
            }
          }
        }
      });

      // Execute transaction
      transaction();
      return true;
    } catch (error) {
      console.error(
        `Error copying from ${sourcePath} to ${destinationPath}:`,
        error,
      );
      return false;
    }
  }

  /**
   * Gets the directory path for a file path
   * @param filePath File path
   * @returns Directory path
   */
  private getDirPath(filePath: string): string {
    if (!filePath.includes(PATH_DELIMITER)) {
      return "";
    }
    return filePath.substring(0, filePath.lastIndexOf(PATH_DELIMITER));
  }

  /**
   * Initializes the database schema if it doesn't exist
   */
  private _initializeDatabase(): void {
    if (this.initialized) return;

    try {
      // Enable foreign keys
      this.db.exec("PRAGMA foreign_keys = ON");

      // Create tables in a transaction
      const transaction = this.db.transaction(() => {
        // Content table
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS ${TABLE_PREFIX}content (
            path TEXT PRIMARY KEY,
            content TEXT NOT NULL,
            type TEXT NOT NULL,
            created_at INTEGER DEFAULT (unixepoch()),
            updated_at INTEGER DEFAULT (unixepoch())
          )
        `);

        // Directories table
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS ${TABLE_PREFIX}directories (
            path TEXT PRIMARY KEY,
            created_at INTEGER DEFAULT (unixepoch())
          )
        `);

        // Metadata table
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS ${TABLE_PREFIX}metadata (
            path TEXT PRIMARY KEY,
            metadata TEXT NOT NULL,
            created_at INTEGER DEFAULT (unixepoch()),
            updated_at INTEGER DEFAULT (unixepoch())
          )
        `);

        // Create indexes for faster path lookups
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}content_path_prefix ON ${TABLE_PREFIX}content(path)
        `);

        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}directories_path_prefix ON ${TABLE_PREFIX}directories(path)
        `);

        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}metadata_path_prefix ON ${TABLE_PREFIX}metadata(path)
        `);
      });

      // Execute transaction
      transaction();
      this.initialized = true;
    } catch (error) {
      console.error("Error initializing database:", error);
      throw new Error(`Failed to initialize SQLite database: ${error}`);
    }
  }

  /**
   * Closes the database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
    }
  }
}
