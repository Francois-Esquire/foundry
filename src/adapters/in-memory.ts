import type { Adapter } from '../core/types';

/**
 * InMemoryAdapter stores all data in memory using JavaScript objects.
 * - Paths are used as keys in a Map structure
 * - Content is stored as string values
 * - Type is stored alongside content in memory
 * - Metadata is stored in a separate Map keyed by path
 */
export class InMemoryAdapter implements Adapter {
  private content: Map<string, { content: string; type: string }> = new Map();
  private metadata: Map<string, Record<string, any>> = new Map();
  private directories: Set<string> = new Set();

  /**
   * Reads content and type from memory
   * @param path Path to the resource
   * @returns Object containing content and type, or null if not found
   */
  async read(path: string): Promise<{ content: string; type: string } | null> {
    return this.content.get(path) || null;
  }

  /**
   * Writes content to memory
   * @param path Path to the resource
   * @param content Content to write
   * @param type Content type
   * @returns True if successful
   */
  async write(path: string, content: string, type: string): Promise<boolean> {
    try {
      // Create parent directories if needed
      const dirPath = this.getDirPath(path);
      if (dirPath && !this.directories.has(dirPath)) {
        await this.createDirectory(dirPath);
      }

      this.content.set(path, { content, type });
      return true;
    } catch (error) {
      console.error(`Error writing to path ${path}:`, error);
      return false;
    }
  }

  /**
   * Deletes a resource from memory
   * @param path Path to the resource
   * @returns True if successful
   */
  async delete(path: string): Promise<boolean> {
    try {
      if (!(await this.exists(path))) {
        return false;
      }

      // Delete the content
      this.content.delete(path);

      // Delete metadata if it exists
      this.metadata.delete(path);

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
    return this.content.has(path) || this.directories.has(path);
  }

  /**
   * Lists resources at a path
   * @param path Directory path to list
   * @returns Array of resource names
   */
  async list(path: string): Promise<string[]> {
    try {
      const result: string[] = [];
      const prefix = path.endsWith('/') ? path : path + '/';

      // Check if the directory exists
      if (!this.directories.has(path) && !path.startsWith('/') && path !== '') {
        return [];
      }

      // Collect all paths that start with the prefix
      for (const storedPath of [...this.content.keys(), ...this.directories]) {
        if (storedPath.startsWith(prefix)) {
          // Get the next path segment
          const relativePath = storedPath.slice(prefix.length);
          const nextSegment = relativePath.split('/')[0];

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
   * Creates a directory in memory
   * @param path Directory path to create
   * @returns True if successful
   */
  async createDirectory(path: string): Promise<boolean> {
    try {
      // Create parent directories if needed
      const parentDir = this.getDirPath(path);
      if (parentDir && !this.directories.has(parentDir) && parentDir !== '') {
        await this.createDirectory(parentDir);
      }

      // Add the directory to the set
      this.directories.add(path);
      return true;
    } catch (error) {
      console.error(`Error creating directory at ${path}:`, error);
      return false;
    }
  }

  /**
   * Deletes a directory from memory
   * @param path Directory path to delete
   * @param recursive Whether to delete contents recursively
   * @returns True if successful
   */
  async deleteDirectory(
    path: string,
    recursive: boolean = false
  ): Promise<boolean> {
    try {
      if (!(await this.exists(path))) {
        return false;
      }

      const prefix = path.endsWith('/') ? path : path + '/';

      // Check if directory has contents
      const contents = await this.list(path);
      if (contents.length > 0 && !recursive) {
        throw new Error(
          `Directory is not empty: ${path}. Pass recursive=true to delete contents.`
        );
      }

      if (recursive) {
        // Delete all content entries that start with the prefix
        for (const storedPath of [...this.content.keys()]) {
          if (storedPath === path || storedPath.startsWith(prefix)) {
            this.content.delete(storedPath);
            this.metadata.delete(storedPath);
          }
        }

        // Delete all subdirectories
        for (const dir of [...this.directories]) {
          if (dir.startsWith(prefix)) {
            this.directories.delete(dir);
          }
        }
      }

      // Remove the directory itself
      this.directories.delete(path);

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
    return this.metadata.get(path) || null;
  }

  /**
   * Sets metadata for a path
   * @param path Path to set metadata for
   * @param metadata Metadata object
   * @returns True if successful
   */
  async setMetadata(
    path: string,
    metadata: Record<string, any>
  ): Promise<boolean> {
    try {
      this.metadata.set(path, { ...metadata });
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
      if (this.directories.has(sourcePath)) {
        // Create the destination directory
        await this.createDirectory(destinationPath);

        // Get all paths that start with the source prefix
        const sourcePrefix = sourcePath.endsWith('/')
          ? sourcePath
          : sourcePath + '/';
        const destPrefix = destinationPath.endsWith('/')
          ? destinationPath
          : destinationPath + '/';

        // Move all content entries
        for (const [path, data] of [...this.content.entries()]) {
          if (path.startsWith(sourcePrefix)) {
            const relativePath = path.slice(sourcePrefix.length);
            const newPath = destPrefix + relativePath;
            this.content.set(newPath, data);
            this.content.delete(path);

            // Move metadata if it exists
            const pathMetadata = this.metadata.get(path);
            if (pathMetadata) {
              this.metadata.set(newPath, pathMetadata);
              this.metadata.delete(path);
            }
          }
        }

        // Move all subdirectories
        for (const dir of [...this.directories]) {
          if (dir.startsWith(sourcePrefix)) {
            const relativePath = dir.slice(sourcePrefix.length);
            const newDir = destPrefix + relativePath;
            this.directories.add(newDir);
            this.directories.delete(dir);
          }
        }

        // Delete the source directory
        this.directories.delete(sourcePath);
      } else {
        // It's a file, copy the content
        const data = this.content.get(sourcePath);
        if (data) {
          // Create parent directory if needed
          const destDirPath = this.getDirPath(destinationPath);
          if (destDirPath && !this.directories.has(destDirPath)) {
            await this.createDirectory(destDirPath);
          }

          // Move the content
          this.content.set(destinationPath, data);
          this.content.delete(sourcePath);

          // Move metadata if it exists
          const metadata = this.metadata.get(sourcePath);
          if (metadata) {
            this.metadata.set(destinationPath, metadata);
            this.metadata.delete(sourcePath);
          }
        }
      }

      return true;
    } catch (error) {
      console.error(
        `Error moving from ${sourcePath} to ${destinationPath}:`,
        error
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
      if (this.directories.has(sourcePath)) {
        // Create the destination directory
        await this.createDirectory(destinationPath);

        // Get all paths that start with the source prefix
        const sourcePrefix = sourcePath.endsWith('/')
          ? sourcePath
          : sourcePath + '/';
        const destPrefix = destinationPath.endsWith('/')
          ? destinationPath
          : destinationPath + '/';

        // Copy all content entries
        for (const [path, data] of [...this.content.entries()]) {
          if (path.startsWith(sourcePrefix)) {
            const relativePath = path.slice(sourcePrefix.length);
            const newPath = destPrefix + relativePath;
            this.content.set(newPath, { ...data });

            // Copy metadata if it exists
            const pathMetadata = this.metadata.get(path);
            if (pathMetadata) {
              this.metadata.set(newPath, { ...pathMetadata });
            }
          }
        }

        // Copy all subdirectories
        for (const dir of [...this.directories]) {
          if (dir.startsWith(sourcePrefix)) {
            const relativePath = dir.slice(sourcePrefix.length);
            const newDir = destPrefix + relativePath;
            this.directories.add(newDir);
          }
        }
      } else {
        // It's a file, copy the content
        const data = this.content.get(sourcePath);
        if (data) {
          // Create parent directory if needed
          const destDirPath = this.getDirPath(destinationPath);
          if (destDirPath && !this.directories.has(destDirPath)) {
            await this.createDirectory(destDirPath);
          }

          // Copy the content
          this.content.set(destinationPath, { ...data });

          // Copy metadata if it exists
          const metadata = this.metadata.get(sourcePath);
          if (metadata) {
            this.metadata.set(destinationPath, { ...metadata });
          }
        }
      }

      return true;
    } catch (error) {
      console.error(
        `Error copying from ${sourcePath} to ${destinationPath}:`,
        error
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
    if (!filePath.includes('/')) {
      return '';
    }
    return filePath.substring(0, filePath.lastIndexOf('/'));
  }
}
