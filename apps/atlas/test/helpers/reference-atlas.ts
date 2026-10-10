import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pairEndpoints } from "../../src/web/codex/resolve";
import type { AtlasData, AtlasRoute } from "../../src/web/types";

/** The capture, saved before routes carried their endpoint files. */
type CapturedAtlas = Omit<AtlasData, "routes"> & {
  routes: Omit<AtlasRoute, "consumerFiles" | "supplierFiles">[];
};

/**
 * Original renderer input, captured before migration. Each test gets its own
 * copy. Its routes gain their endpoint files through the codex's own join, as
 * `loadAtlas` gives them now.
 */
export async function loadAtlas(): Promise<AtlasData> {
  const captured = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../fixtures/atlas.json"), "utf8")
  ) as CapturedAtlas;
  const endpoints = pairEndpoints(
    captured.fileEdges,
    new Map(
      captured.territories.flatMap((p) => p.files.map((f) => [f.id, p.id]))
    )
  );
  return {
    ...captured,
    routes: captured.routes.map((route) => ({
      ...route,
      ...endpoints(route.from, route.to),
    })),
  };
}
