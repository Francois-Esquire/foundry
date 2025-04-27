import { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

/**
 * Options for filtering files during traversal.
 */
export interface TraverseOptions {
  /** List of allowed file extensions (e.g., ['.ts', '.js']). Processing stops if an extension doesn't match. */
  allowedExtensions?: string[];
  /** List of blocked file extensions (e.g., ['.log', '.tmp']). Files with these extensions are skipped. */
  blockedExtensions?: string[];
}

/**
 * Recursively traverses a directory, reads files, applies filters and a transform to their content.
 *
 * @param directoryPath - The absolute path to the directory to traverse.
 * @param transformFn - An async function to apply to each file's content.
 *                      Takes the file path (string) and its content (string).
 *                      Should return the transformed content (T) or null/undefined to skip the file.
 * @param options - Optional filtering criteria (allowed/blocked extensions).
 * @param filterFn - Optional async function to determine if a file should be processed *before* reading.
 *                   Takes the file path (string) and the fs.Dirent object.
 *                   Should return true to process the file, false to skip.
 * @param results - A Map used internally for recursion to collect results.
 * @returns A Promise that resolves to a Map mapping file paths to their transformed content.
 */
export async function traverseDirectory<T>(
  directoryPath: string,
  transformFn: (
    filePath: string,
    content: string,
  ) => Promise<T | null | undefined>,
  options: TraverseOptions = {},
  filterFn: (filePath: string, entry: Dirent) => Promise<boolean> = async () =>
    true,
  results: Map<string, T> = new Map(),
): Promise<Map<string, T>> {
  try {
    const absolutePath = resolve(directoryPath);
    const entries = await readdir(absolutePath, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = join(absolutePath, entry.name);

      if (entry.isDirectory()) {
        // Recursively traverse subdirectory, passing all functions and options
        await traverseDirectory(
          entryPath,
          transformFn,
          options,
          filterFn,
          results,
        );
      } else if (entry.isFile()) {
        // Apply the pre-read filter function first
        if (!(await filterFn(entryPath, entry))) {
          continue; // Skip if filterFn returns false
        }

        const extension = extname(entry.name).toLowerCase();

        // Apply extension filters
        if (
          options.allowedExtensions &&
          !options.allowedExtensions.includes(extension)
        ) {
          continue; // Skip if extension is not allowed
        }
        if (
          options.blockedExtensions &&
          options.blockedExtensions.includes(extension)
        ) {
          continue; // Skip if extension is blocked
        }

        try {
          // Read file content
          const content = await readFile(entryPath, "utf-8");
          // Apply the transform function to the file path and content
          const transformedContent = await transformFn(entryPath, content);

          // Add the transformed content to the results map if it's not null/undefined
          if (transformedContent != null) {
            results.set(entryPath, transformedContent);
          }
        } catch (readError) {
          console.error(
            `Error reading or transforming file ${entryPath}:`,
            readError,
          );
        }
      }
      // Note: Symlinks, block devices, etc., are ignored.
    }
  } catch (dirError) {
    // Log errors like permission issues but continue traversal if possible
    console.error(`Error reading directory ${directoryPath}:`, dirError);
  }

  return results;
}

/**
 * Reads a single file, applies filters (extension checks), and transforms its content.
 *
 * @param filePath - The absolute path to the file to process.
 * @param transformFn - An async function to apply to the file's content.
 *                      Takes the file path (string) and its content (string).
 *                      Should return the transformed content (T) or null/undefined to skip.
 * @param options - Optional filtering criteria (allowed/blocked extensions).
 * @returns A Promise resolving to the transformed content (T) or null/undefined if the file
 *          doesn't exist, isn't a file, is filtered out, or the transform returns null/undefined.
 */
export async function processSingleFile<T>(
  filePath: string,
  transformFn: (
    filePath: string,
    content: string,
  ) => Promise<T | null | undefined>,
  options: TraverseOptions = {},
): Promise<T | null | undefined> {
  try {
    const absolutePath = resolve(filePath);
    const fileStat = await stat(absolutePath); // Check existence and type

    if (!fileStat.isFile()) {
      console.warn(`[processSingleFile] Path is not a file: ${absolutePath}`);
      return null; // Not a file
    }

    const extension = extname(absolutePath).toLowerCase();

    // Apply extension filters
    if (
      options.allowedExtensions &&
      !options.allowedExtensions.includes(extension)
    ) {
      console.log(
        `[processSingleFile] Skipping due to allowedExtensions: ${absolutePath}`,
      );
      return null; // Skip if extension is not allowed
    }
    if (
      options.blockedExtensions &&
      options.blockedExtensions.includes(extension)
    ) {
      console.log(
        `[processSingleFile] Skipping due to blockedExtensions: ${absolutePath}`,
      );
      return null; // Skip if extension is blocked
    }

    // Read file content
    const content = await readFile(absolutePath, "utf-8");
    // Apply the transform function
    const transformedContent = await transformFn(absolutePath, content);

    return transformedContent;
  } catch (error: any) {
    if (error.code === "ENOENT") {
      // File doesn't exist - not necessarily an error in all contexts
      console.log(`[processSingleFile] File not found: ${filePath}`);
    } else {
      // Log other errors (permissions, read errors, transform errors)
      console.error(
        `[processSingleFile] Error processing file ${filePath}:`,
        error,
      );
    }
    return null; // Return null on any error
  }
}

// Example usage (optional, can be removed or kept for testing):
// (async () => {
//   try {
//     const startDir = process.cwd(); // Or specify a different starting directory
//     console.log(`Traversing directory: ${startDir}`);
//     // Example with a simple transform (e.g., make relative to startDir)
//     const makeRelative = async (filePath: string) => {
//       return relative(startDir, filePath);
//     };
//     const files = await traverseDirectory(startDir, new Set(), makeRelative);
//     // const files = await traverseDirectory(startDir); // Without transform
//     console.log('\nFound files (transformed):');
//     files.forEach(file => console.log(file));
//     console.log(`\nTotal files found: ${files.size}`);
//   } catch (err) {
//     console.error('Error during traversal:', err);
//   }
// })();
