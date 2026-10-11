import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { importPairs } from "../../src/lib/lenses/import-traffic";
import type { AtlasData, AtlasRoute, Territory } from "../../src/web/types";
import { singleFrame } from "./frames";

/** The capture, saved before routes carried their endpoint files, before the layer scale, and before islands knew their folders. */
type CapturedAtlas = Omit<
  AtlasData,
  "folderCells" | "frames" | "packageLayers" | "routes" | "territories"
> & {
  /** When the capture's dataset was saved; the one frame's pin now. */
  generatedAt: string;
  routes: Omit<AtlasRoute, "consumerFiles" | "supplierFiles">[];
  territories: Omit<Territory, "folder">[];
};

/** The capture's packages all sit two folders deep, as `packages/agents`: the folder its manifest would give. */
function capturedFolder(territory: Omit<Territory, "folder">): string {
  return territory.files[0]?.directory.split("/").slice(0, 2).join("/") ?? "";
}

/**
 * Original renderer input, captured before migration. Each test gets its own
 * copy. Its routes gain their endpoint files through the import-traffic lens's join, as
 * `loadAtlas` gives them now.
 */
export async function loadAtlas(): Promise<AtlasData> {
  const captured = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../fixtures/atlas.json"), "utf8")
  ) as CapturedAtlas;
  // Joined as the import-traffic lens joins them at scan time.
  const pairs = new Map(
    importPairs(
      captured.fileEdges,
      new Map(
        captured.territories.flatMap((p) => p.files.map((f) => [f.id, p.id]))
      )
    ).map((pair) => [`${pair.from}→${pair.to}`, pair])
  );
  const endpoints = (from: string, to: string) => {
    const pair = pairs.get(`${from}→${to}`);
    return {
      consumerFiles: pair?.consumerFiles ?? [],
      supplierFiles: pair?.supplierFiles ?? [],
    };
  };
  const { generatedAt, ...saved } = captured;
  return {
    ...saved,
    // Nor the cell trees the layout of its day did not make.
    folderCells: {},
    // One frame, a single workspace's, whose lenses say nothing: the capture
    // has no nesting, domains, placement or proximity lens, so no place
    // departs.
    frames: [
      singleFrame(
        captured.territories.map((territory) => territory.id),
        {},
        generatedAt
      ),
    ],
    // The capture has no layers; its scale is empty, so none is drawn.
    packageLayers: {},
    routes: captured.routes.map((route) => ({
      ...route,
      ...endpoints(route.from, route.to),
    })),
    territories: captured.territories.map((territory) => ({
      ...territory,
      folder: capturedFolder(territory),
    })),
  };
}
