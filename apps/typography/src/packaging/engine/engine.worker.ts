/** The browser's font engine: Pyodide and fontTools, off the main thread. */
import { loadPyodide } from "pyodide";
import { createFontBuilder } from "./host";
import { type EngineScope, serveEngine } from "./serve";

/** The runtime and wheels that scripts/fetch-engine.ts prepares in public/engine. */
const ENGINE_URL = "/engine/";

// The project compiles with both DOM and worker types, so `self` reads as a window.
serveEngine(self as unknown as EngineScope, async () =>
  createFontBuilder(await loadPyodide({ indexURL: ENGINE_URL }))
);
