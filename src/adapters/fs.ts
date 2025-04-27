import * as fs from "fs";
import * as path from "path";

import type { Adapter } from "./types";

/**
 * FileSystemAdapter maps operations directly to the local file system.
 * - Paths map directly to file system paths relative to a basePath
 * - Content is stored as actual files
 * - Type can be inferred from file extension or stored in metadata
 * - Metadata is stored in a hidden directory alongside content files
 */
export class FileSystemAdapter implements Adapter {
  private basePath: string;
  private metadataDir: string;

  /**
   * Creates a new FileSystemAdapter
   * @param options Configuration options
   * @param options.basePath Base directory for all operations
   * @param options.metadataDir Directory name for storing metadata (default: '.foundry')
   */
  constructor(options: { basePath: string; metadataDir?: string }) {
    this.basePath = options.basePath;
    this.metadataDir = options.metadataDir || ".foundry";
  }

  /**
   * Reads content and type from a file
   * @param path Path to the file
   * @returns Object containing content and type, or null if file doesn't exist
   */
  async read(path: string): Promise<{ content: string; type: string } | null> {
    const fullPath = this.resolvePath(path);

    try {
      if (!(await this.exists(path))) {
        return null;
      }

      const content = await fs.promises.readFile(fullPath, "utf-8");
      const metadata = await this.getMetadata(path);
      const type = metadata?.type || this.inferTypeFromPath(path);

      return { content, type };
    } catch (error) {
      console.error(`Error reading file at ${path}:`, error);
      return null;
    }
  }

  /**
   * Writes content to a file
   * @param path Path to the file
   * @param content Content to write
   * @param type Content type
   * @returns True if successful
   */
  async write(path: string, content: string, type: string): Promise<boolean> {
    const fullPath = this.resolvePath(path);
    const dirPath = this.getDirPath(fullPath);

    try {
      // Ensure directory exists
      await fs.promises.mkdir(dirPath, { recursive: true });

      // Write content
      await fs.promises.writeFile(fullPath, content, "utf-8");

      // Store type in metadata
      const metadata = (await this.getMetadata(path)) || {};
      metadata.type = type;
      await this.setMetadata(path, metadata);

      return true;
    } catch (error) {
      console.error(`Error writing to file at ${path}:`, error);
      return false;
    }
  }

  /**
   * Deletes a file
   * @param path Path to the file
   * @returns True if successful
   */
  async delete(path: string): Promise<boolean> {
    const fullPath = this.resolvePath(path);

    try {
      if (!(await this.exists(path))) {
        return false;
      }

      await fs.promises.unlink(fullPath);

      // Also delete metadata if it exists
      const metadataPath = this.getMetadataPath(path);
      if (fs.existsSync(metadataPath)) {
        await fs.promises.unlink(metadataPath);
      }

      return true;
    } catch (error) {
      console.error(`Error deleting file at ${path}:`, error);
      return false;
    }
  }

  /**
   * Checks if a file or directory exists
   * @param path Path to check
   * @returns True if the path exists
   */
  async exists(path: string): Promise<boolean> {
    const fullPath = this.resolvePath(path);

    try {
      await fs.promises.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Lists files and directories at a path
   * @param path Directory path to list
   * @returns Array of file and directory names
   */
  async list(path: string): Promise<string[]> {
    const fullPath = this.resolvePath(path);

    try {
      if (!(await this.exists(path))) {
        return [];
      }

      const entries = await fs.promises.readdir(fullPath);

      // Filter out metadata directory
      return entries.filter((entry) => entry !== this.metadataDir);
    } catch (error) {
      console.error(`Error listing directory at ${path}:`, error);
      return [];
    }
  }

  /**
   * Creates a directory
   * @param path Directory path to create
   * @returns True if successful
   */
  async createDirectory(path: string): Promise<boolean> {
    const fullPath = this.resolvePath(path);

    try {
      await fs.promises.mkdir(fullPath, { recursive: true });
      return true;
    } catch (error) {
      console.error(`Error creating directory at ${path}:`, error);
      return false;
    }
  }

  /**
   * Deletes a directory
   * @param path Directory path to delete
   * @param recursive Whether to delete contents recursively
   * @returns True if successful
   */
  async deleteDirectory(
    path: string,
    recursive: boolean = false,
  ): Promise<boolean> {
    const fullPath = this.resolvePath(path);

    try {
      if (!(await this.exists(path))) {
        return false;
      }

      if (recursive) {
        // Delete directory and all contents
        await fs.promises.rm(fullPath, { recursive: true, force: true });
      } else {
        // Only delete if directory is empty
        const entries = await fs.promises.readdir(fullPath);
        if (entries.length > 0) {
          throw new Error(
            `Directory is not empty: ${path}. Pass recursive=true to delete contents.`,
          );
        }
        await fs.promises.rmdir(fullPath);
      }

      // Also delete metadata directory if it exists
      const metadataDir = this.getMetadataDirPath(path);
      if (fs.existsSync(metadataDir)) {
        await fs.promises.rmdir(metadataDir, { recursive: true });
      }

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
    const metadataPath = this.getMetadataPath(path);

    try {
      if (!fs.existsSync(metadataPath)) {
        return null;
      }

      const content = await fs.promises.readFile(metadataPath, "utf-8");
      return JSON.parse(content);
    } catch (error) {
      console.error(`Error reading metadata for ${path}:`, error);
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
    const metadataPath = this.getMetadataPath(path);
    const metadataDir = this.getMetadataDirPath(path);

    try {
      // Ensure metadata directory exists
      await fs.promises.mkdir(metadataDir, { recursive: true });

      // Write metadata
      await fs.promises.writeFile(
        metadataPath,
        JSON.stringify(metadata, null, 2),
        "utf-8",
      );

      return true;
    } catch (error) {
      console.error(`Error writing metadata for ${path}:`, error);
      return false;
    }
  }

  /**
   * Moves a file or directory
   * @param sourcePath Source path
   * @param destinationPath Destination path
   * @returns True if successful
   */
  async move(sourcePath: string, destinationPath: string): Promise<boolean> {
    const fullSourcePath = this.resolvePath(sourcePath);
    const fullDestPath = this.resolvePath(destinationPath);
    const destDirPath = this.getDirPath(fullDestPath);

    try {
      if (!(await this.exists(sourcePath))) {
        return false;
      }

      // Ensure destination directory exists
      await fs.promises.mkdir(destDirPath, { recursive: true });

      // Move the file or directory
      await fs.promises.rename(fullSourcePath, fullDestPath);

      // Move metadata if it exists
      const sourceMetadataPath = this.getMetadataPath(sourcePath);
      if (fs.existsSync(sourceMetadataPath)) {
        const destMetadataPath = this.getMetadataPath(destinationPath);
        const destMetadataDir = this.getMetadataDirPath(destinationPath);

        // Ensure destination metadata directory exists
        await fs.promises.mkdir(destMetadataDir, { recursive: true });

        // Move metadata file
        await fs.promises.rename(sourceMetadataPath, destMetadataPath);
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
   * Copies a file or directory
   * @param sourcePath Source path
   * @param destinationPath Destination path
   * @returns True if successful
   */
  async copy(sourcePath: string, destinationPath: string): Promise<boolean> {
    const fullSourcePath = this.resolvePath(sourcePath);
    const fullDestPath = this.resolvePath(destinationPath);
    const destDirPath = this.getDirPath(fullDestPath);

    try {
      if (!(await this.exists(sourcePath))) {
        return false;
      }

      // Ensure destination directory exists
      await fs.promises.mkdir(destDirPath, { recursive: true });

      const stats = await fs.promises.stat(fullSourcePath);

      if (stats.isDirectory()) {
        // Copy directory recursively
        await this.copyDir(fullSourcePath, fullDestPath);
      } else {
        // Copy file
        await fs.promises.copyFile(fullSourcePath, fullDestPath);
      }

      // Copy metadata if it exists
      const sourceMetadata = await this.getMetadata(sourcePath);
      if (sourceMetadata) {
        await this.setMetadata(destinationPath, sourceMetadata);
      }

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
   * Resolves a path relative to the base path
   * @param relativePath Path relative to base path
   * @returns Absolute file system path
   */
  private resolvePath(relativePath: string): string {
    // Normalize path to handle '..' and '.'
    const normalizedPath = path.normalize(relativePath);
    // Join with base path
    return path.join(this.basePath, normalizedPath);
  }

  /**
   * Gets the directory path for a file path
   * @param filePath File path
   * @returns Directory path
   */
  private getDirPath(filePath: string): string {
    return path.dirname(filePath);
  }

  /**
   * Gets the path to the metadata file for a given path
   * @param relativePath Path to get metadata for
   * @returns Path to metadata file
   */
  private getMetadataPath(relativePath: string): string {
    const metadataDir = this.getMetadataDirPath(relativePath);
    const metadataFileName = path.basename(relativePath) + ".meta.json";
    return path.join(metadataDir, metadataFileName);
  }

  /**
   * Gets the path to the metadata directory for a given path
   * @param relativePath Path to get metadata directory for
   * @returns Path to metadata directory
   */
  private getMetadataDirPath(relativePath: string): string {
    const dirPath = path.dirname(this.resolvePath(relativePath));
    return path.join(dirPath, this.metadataDir);
  }

  /**
   * Infers content type from file extension
   * @param filePath File path
   * @returns Content type
   */
  private inferTypeFromPath(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
      case ".md":
        return "text/markdown";
      case ".json":
        return "application/json";
      case ".js":
        return "application/javascript";
      case ".ts":
        return "application/typescript";
      case ".html":
        return "text/html";
      case ".css":
        return "text/css";
      case ".txt":
        return "text/plain";
      default:
        return "application/octet-stream";
    }
  }

  /**
   * Recursively copies a directory
   * @param source Source directory
   * @param destination Destination directory
   */
  private async copyDir(source: string, destination: string): Promise<void> {
    // Create destination directory
    await fs.promises.mkdir(destination, { recursive: true });

    // Get all entries in the source directory
    const entries = await fs.promises.readdir(source, { withFileTypes: true });

    // Process each entry
    for (const entry of entries) {
      const srcPath = path.join(source, entry.name);
      const destPath = path.join(destination, entry.name);

      if (entry.isDirectory()) {
        // Skip metadata directory
        if (entry.name === this.metadataDir) {
          continue;
        }
        // Recursively copy subdirectory
        await this.copyDir(srcPath, destPath);
      } else {
        // Copy file
        await fs.promises.copyFile(srcPath, destPath);
      }
    }
  }
}
