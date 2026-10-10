import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isMissingPath } from "@foundry/lib/atomic-file";
import type { DatasetTransport } from "./dataset";

/** Reads a dataset saved in `output` from the file system. */
export function fileTransport(output: string): DatasetTransport {
  return async (path) => {
    let text: string;
    try {
      text = await readFile(join(output, path), "utf8");
    } catch (error) {
      if (isMissingPath(error)) {
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
