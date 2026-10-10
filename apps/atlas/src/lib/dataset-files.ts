import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatasetTransport } from "./dataset";

function missing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

/** Reads a dataset saved in `output` from the file system. */
export function fileTransport(output: string): DatasetTransport {
  return async (path) => {
    let text: string;
    try {
      text = await readFile(join(output, path), "utf8");
    } catch (error) {
      if (missing(error)) {
        return;
      }
      throw error;
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`Could not parse ${path}.`, { cause: error });
    }
  };
}
