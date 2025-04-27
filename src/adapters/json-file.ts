import * as fs from "fs";
import * as path from "path";

import type { Adapter } from "./types";

/**
 * Interface for the internal data structure stored in the JSON file
 */
interface JsonFileData {
  content: { [path: string]: { content: string; type: string } };
  metadata: { [path: string]: Record<string, any> };
  directories: string[];
}

/**
 * JsonFileAdapter stores all data (content, type, metadata, directory structure)
 * within a single JSON file.
 *
 * - Loads data from the specified JSON file upon initialization
 * - Manages data in memory using objects
 * - Persists the entire data structure back to the JSON file after modifications
 */
export class JsonFileAdapter implements Adapter {
  private filePath: string;
  private data: JsonFileData;
  private savePromise: Promise<void> | null = null;
  private saveTimeout: NodeJS.Timeout | null = null;
  private saveDelay = 100; // ms to debounce saves

  /**
   * Creates a new JsonFileAdapter
   * @param options Configuration options
   * @param options.filePath Path to the JSON file for storing all data
   */
  constructor(options: { filePath: string }) {
    this.filePath = options.filePath;
    this.data = {
      content: {},
      metadata: {},
      directories: [],
    };

    // Load data immediately (synchronously) to ensure it's available
    this._loadData();
  }

  /**
   * Reads content and type from memory
   * @param path Path to the resource
   * @returns Object containing content and type, or null if not found
   */
  async read(path: string): Promise<{ content: string; type: string } | null> {
    return this.data.content[path] || null;
  }

  /**
   * Writes content to memory and persists to JSON file
   * @param path Path to the resource
   * @param content Content to write
   * @param type Content type
   * @returns True if successful
   */
  async write(path: string, content: string, type: string): Promise<boolean> {
    try {
      // Create parent directories if needed
      const dirPath = this.getDirPath(path);
      if (dirPath && !this.data.directories.includes(dirPath)) {
        await this.createDirectory(dirPath);
      }

      this.data.content[path] = { content, type };
      await this._saveData();
      return true;
    } catch (error) {
      console.error(`Error writing to path ${path}:`, error);
      return false;
    }
  }

  /**
   * Deletes a resource from memory and persists to JSON file
   * @param path Path to the resource
   * @returns True if successful
   */
  async delete(path: string): Promise<boolean> {
    try {
      if (!(await this.exists(path))) {
        return false;
      }

      // Delete the content
      delete this.data.content[path];

      // Delete metadata if it exists
      delete this.data.metadata[path];

      await this._saveData();
      return true;
    } catch (error) {
      console.error(`Error deleting path ${path}:`, error);
      return false;
    }
  }

  /**
   * Checks if a resource exists in memory
   * @param path Path to check
   * @returns True if the path exists
   */
  async exists(path: string): Promise<boolean> {
    return path in this.data.content || this.data.directories.includes(path);
  }

  /**
   * Lists resources at a path
   * @param path Directory path to list
   * @returns Array of resource names
   */
  async list(path: string): Promise<string[]> {
    try {
      const result: string[] = [];
      const prefix = path.endsWith("/") ? path : path + "/";

      // Check if the directory exists
      if (
        !this.data.directories.includes(path) &&
        !path.startsWith("/") &&
        path !== ""
      ) {
        return [];
      }

      // Collect all paths that start with the prefix
      for (const storedPath of [
        ...Object.keys(this.data.content),
        ...this.data.directories,
      ]) {
        if (storedPath.startsWith(prefix)) {
          // Get the next path segment
          const relativePath = storedPath.slice(prefix.length);
          const nextSegment = relativePath.split("/")[0];

          if (nextSegment && !result.includes(nextSegment)) {
            result.push(nextSegment);
          }
        }
      }

      return result;
    } catch (error) {
      console.error(`Error listing directory at ${path}:`, error);
      return [];
    }
  }

  /**
   * Creates a directory in memory and persists to JSON file
   * @param path Directory path to create
   * @returns True if successful
   */
  async createDirectory(path: string): Promise<boolean> {
    try {
      // Create parent directories if needed
      const parentDir = this.getDirPath(path);
      if (
        parentDir &&
        !this.data.directories.includes(parentDir) &&
        parentDir !== ""
      ) {
        await this.createDirectory(parentDir);
      }

      // Add the directory to the array if it doesn't already exist
      if (!this.data.directories.includes(path)) {
        this.data.directories.push(path);
        await this._saveData();
      }

      return true;
    } catch (error) {
      console.error(`Error creating directory at ${path}:`, error);
      return false;
    }
  }

  /**
   * Deletes a directory from memory and persists to JSON file
   * @param path Directory path to delete
   * @param recursive Whether to delete contents recursively
   * @returns True if successful
   */
  async deleteDirectory(
    path: string,
    recursive: boolean = false,
  ): Promise<boolean> {
    try {
      if (!this.data.directories.includes(path)) {
        return false;
      }

      const prefix = path.endsWith("/") ? path : path + "/";

      // Check if directory has contents
      const contents = await this.list(path);
      if (contents.length > 0 && !recursive) {
        throw new Error(
          `Directory is not empty: ${path}. Pass recursive=true to delete contents.`,
        );
      }

      // Remove the directory itself
      const dirIndex = this.data.directories.indexOf(path);
      if (dirIndex !== -1) {
        this.data.directories.splice(dirIndex, 1);
      }

      if (recursive) {
        // Delete all content entries that start with the prefix
        for (const storedPath of Object.keys(this.data.content)) {
          if (storedPath === path || storedPath.startsWith(prefix)) {
            delete this.data.content[storedPath];
            delete this.data.metadata[storedPath];
          }
        }

        // Delete all subdirectories
        this.data.directories = this.data.directories.filter(
          (dir) => dir !== path && !dir.startsWith(prefix),
        );
      }

      await this._saveData();
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
    return this.data.metadata[path] || null;
  }

  /**
   * Sets metadata for a path and persists to JSON file
   * @param path Path to set metadata for
   * @param metadata Metadata object
   * @returns True if successful
   */
  async setMetadata(
    path: string,
    metadata: Record<string, any>,
  ): Promise<boolean> {
    try {
      this.data.metadata[path] = { ...metadata };
      await this._saveData();
      return true;
    } catch (error) {
      console.error(`Error setting metadata for ${path}:`, error);
      return false;
    }
  }

  /**
   * Moves a resource from one path to another and persists to JSON file
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
      if (this.data.directories.includes(sourcePath)) {
        // Create the destination directory
        await this.createDirectory(destinationPath);

        // Get all paths that start with the source prefix
        const sourcePrefix = sourcePath.endsWith("/")
          ? sourcePath
          : sourcePath + "/";
        const destPrefix = destinationPath.endsWith("/")
          ? destinationPath
          : destinationPath + "/";

        // Move all content entries
        for (const path of Object.keys(this.data.content)) {
          if (path.startsWith(sourcePrefix)) {
            const relativePath = path.slice(sourcePrefix.length);
            const newPath = destPrefix + relativePath;
            const contentData = this.data.content[path];
            if (contentData) {
              this.data.content[newPath] = contentData;
              delete this.data.content[path];
            }

            // Move metadata if it exists
            if (path in this.data.metadata) {
              const metaData = this.data.metadata[path];
              if (metaData) {
                this.data.metadata[newPath] = metaData;
                delete this.data.metadata[path];
              }
            }
          }
        }

        // Move all subdirectories
        const newDirectories: string[] = [];
        for (const dir of this.data.directories) {
          if (dir === sourcePath) {
            // Skip the source directory as we've already created the destination
            continue;
          } else if (dir.startsWith(sourcePrefix)) {
            const relativePath = dir.slice(sourcePrefix.length);
            const newDir = destPrefix + relativePath;
            newDirectories.push(newDir);
          } else {
            newDirectories.push(dir);
          }
        }
        this.data.directories = newDirectories;
      } else {
        // It's a file, copy the content
        const data = this.data.content[sourcePath];
        if (data) {
          // Create parent directory if needed
          const destDirPath = this.getDirPath(destinationPath);
          if (destDirPath && !this.data.directories.includes(destDirPath)) {
            await this.createDirectory(destDirPath);
          }

          // Move the content
          this.data.content[destinationPath] = data;
          delete this.data.content[sourcePath];

          // Move metadata if it exists
          if (sourcePath in this.data.metadata) {
            const metaData = this.data.metadata[sourcePath];
            if (metaData) {
              this.data.metadata[destinationPath] = metaData;
              delete this.data.metadata[sourcePath];
            }
          }
        }
      }

      await this._saveData();
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
   * Copies a resource from one path to another and persists to JSON file
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
      if (this.data.directories.includes(sourcePath)) {
        // Create the destination directory
        await this.createDirectory(destinationPath);

        // Get all paths that start with the source prefix
        const sourcePrefix = sourcePath.endsWith("/")
          ? sourcePath
          : sourcePath + "/";
        const destPrefix = destinationPath.endsWith("/")
          ? destinationPath
          : destinationPath + "/";

        // Copy all content entries
        for (const path of Object.keys(this.data.content)) {
          if (path.startsWith(sourcePrefix)) {
            const relativePath = path.slice(sourcePrefix.length);
            const newPath = destPrefix + relativePath;
            const contentData = this.data.content[path];
            if (contentData) {
              this.data.content[newPath] = { ...contentData };
            }

            // Copy metadata if it exists
            if (path in this.data.metadata) {
              const metaData = this.data.metadata[path];
              if (metaData) {
                this.data.metadata[newPath] = { ...metaData };
              }
            }
          }
        }

        // Copy all subdirectories
        for (const dir of this.data.directories) {
          if (dir.startsWith(sourcePrefix) && dir !== sourcePath) {
            const relativePath = dir.slice(sourcePrefix.length);
            const newDir = destPrefix + relativePath;
            if (!this.data.directories.includes(newDir)) {
              this.data.directories.push(newDir);
            }
          }
        }
      } else {
        // It's a file, copy the content
        const data = this.data.content[sourcePath];
        if (data) {
          // Create parent directory if needed
          const destDirPath = this.getDirPath(destinationPath);
          if (destDirPath && !this.data.directories.includes(destDirPath)) {
            await this.createDirectory(destDirPath);
          }

          // Copy the content
          this.data.content[destinationPath] = { ...data };

          // Copy metadata if it exists
          if (sourcePath in this.data.metadata) {
            const metaData = this.data.metadata[sourcePath];
            if (metaData) {
              this.data.metadata[destinationPath] = { ...metaData };
            }
          }
        }
      }

      await this._saveData();
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
    if (!filePath.includes("/")) {
      return "";
    }
    return filePath.substring(0, filePath.lastIndexOf("/"));
  }

  /**
   * Loads data from the JSON file
   * If the file doesn't exist, initializes with empty data
   */
  private _loadData(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const fileContent = fs.readFileSync(this.filePath, "utf-8");
        try {
          this.data = JSON.parse(fileContent);

          // Ensure the data structure is valid
          if (!this.data.content) this.data.content = {};
          if (!this.data.metadata) this.data.metadata = {};
          if (!this.data.directories) this.data.directories = [];
        } catch (parseError) {
          console.error(
            `Error parsing JSON file ${this.filePath}:`,
            parseError,
          );
          // Initialize with empty data on parse error
          this.data = {
            content: {},
            metadata: {},
            directories: [],
          };
        }
      } else {
        // Initialize with empty data if file doesn't exist
        this.data = {
          content: {},
          metadata: {},
          directories: [],
        };

        // Create the file with empty data
        this._saveData();
      }
    } catch (error) {
      console.error(`Error loading data from ${this.filePath}:`, error);
      // Initialize with empty data on any error
      this.data = {
        content: {},
        metadata: {},
        directories: [],
      };
    }
  }

  /**
   * Saves data to the JSON file
   * Uses debouncing to prevent excessive writes
   * @returns Promise that resolves when the save is complete
   */
  private _saveData(): Promise<void> {
    // If there's a pending save, return that promise
    if (this.savePromise) {
      return this.savePromise;
    }

    // If there's a pending timeout, clear it
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }

    // Create a new promise for this save operation
    this.savePromise = new Promise<void>((resolve, reject) => {
      // Set a timeout to debounce multiple rapid saves
      this.saveTimeout = setTimeout(() => {
        // Perform the actual save
        try {
          // Ensure the directory exists
          const dirPath = path.dirname(this.filePath);
          if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
          }

          // Write to a temporary file first for atomicity
          const tempPath = `${this.filePath}.tmp`;
          fs.writeFileSync(
            tempPath,
            JSON.stringify(this.data, null, 2),
            "utf-8",
          );

          // Rename the temp file to the actual file (atomic operation)
          fs.renameSync(tempPath, this.filePath);

          // Clear the promise and timeout
          this.savePromise = null;
          this.saveTimeout = null;

          resolve();
        } catch (error) {
          console.error(`Error saving data to ${this.filePath}:`, error);

          // Clear the promise and timeout
          this.savePromise = null;
          this.saveTimeout = null;

          reject(error);
        }
      }, this.saveDelay);
    });

    return this.savePromise;
  }
}
