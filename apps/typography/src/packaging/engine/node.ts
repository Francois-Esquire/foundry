/** Loads the font engine in Node, for tests and scripts. */
import path from "node:path";
import { loadPyodide } from "pyodide";
import type { FontBuilder } from "../building";
import { createFontBuilder } from "./host";

/** Wheels are read from here, and downloaded into it on first use. */
const ENGINE_DIR = path.join(import.meta.dirname, "../../../public/engine");

let shared: Promise<FontBuilder> | undefined;

/** One engine per process: starting the runtime takes about a second. */
export const nodeFontBuilder = (): Promise<FontBuilder> => {
  shared ??= loadPyodide({ packageCacheDir: ENGINE_DIR }).then(
    createFontBuilder
  );
  return shared;
};
