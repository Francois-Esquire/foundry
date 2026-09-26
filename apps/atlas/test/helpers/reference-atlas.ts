import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AtlasData } from "../../src/web/types";

// Original renderer input, captured before migration. Each test gets its own copy.
export async function loadAtlas(): Promise<AtlasData> {
  return JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../fixtures/atlas.json"), "utf8")
  ) as AtlasData;
}
