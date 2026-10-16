import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SpyglassData } from "../../src/web/types";

/** A current Foundry capture. Each test gets its own copy of the renderer input. */
export async function loadSpyglass(): Promise<SpyglassData> {
  return JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, "../fixtures/spyglass.json"),
      "utf8"
    )
  ) as SpyglassData;
}
