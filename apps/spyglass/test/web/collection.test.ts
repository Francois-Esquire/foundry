import assert from "node:assert/strict";
import { afterEach, expect, it, vi } from "vitest";
import { DatasetNotFoundError } from "../../src/lib/dataset";
import { archipelagoRims } from "../../src/web/archipelago";
import { composeCollection } from "../../src/web/collection";
import { crossingPairs, crossingsOf } from "../../src/web/crossings";
import {
  frameOf,
  islandName,
  islandsByFrame,
  qualifySpyglassData,
  type SpyglassData,
  type Territory,
} from "../../src/web/data/types";
import { readCollectionManifest } from "../../src/web/dataset";
import { frameSea, relayoutSpyglass } from "../../src/web/geography";
import { loadSpyglass } from "../../src/web/load-spyglass";
import { loadSpyglass as referenceSpyglass } from "../helpers/reference-spyglass";
import { twinIds, twins } from "../helpers/twins";

afterEach(() => {
  vi.unstubAllGlobals();
});

const extent = (islands: readonly Territory[]) => ({
  left: Math.min(...islands.map((p) => p.x - p.radius)),
  right: Math.max(...islands.map((p) => p.x + p.radius)),
});

it("gives two copies of one workspace twice the islands and files, every id unique, and every endpoint resolving", async () => {
  const { spyglass, single } = await twins();
  const files = spyglass.territories.flatMap((territory) => territory.files);
  expect(spyglass.territories).toHaveLength(2 * single.territories.length);
  expect(files).toHaveLength(
    2 * single.territories.flatMap((territory) => territory.files).length
  );
  const islandIds = spyglass.territories.map((territory) => territory.id);
  const fileIds = files.map((file) => file.id);
  expect(new Set(islandIds).size).toBe(islandIds.length);
  expect(new Set(fileIds).size).toBe(fileIds.length);
  const islands = new Set(islandIds);
  const known = new Set(fileIds);
  expect(spyglass.routes).toHaveLength(2 * single.routes.length);
  for (const route of spyglass.routes) {
    expect(islands.has(route.from) && islands.has(route.to)).toBe(true);
    for (const file of [...route.consumerFiles, ...route.supplierFiles]) {
      expect(known.has(file)).toBe(true);
    }
  }
  expect(spyglass.fileEdges).toHaveLength(2 * single.fileEdges.length);
  for (const edge of spyglass.fileEdges) {
    expect(known.has(edge.source) && known.has(edge.target)).toBe(true);
  }
  expect(spyglass.declaredDependencies?.length).toBeGreaterThan(0);
  for (const dependency of spyglass.declaredDependencies ?? []) {
    expect(islands.has(dependency.from) && islands.has(dependency.to)).toBe(
      true
    );
  }
  for (const crossing of spyglass.crossings ?? []) {
    expect(islands.has(crossing.from) && islands.has(crossing.to)).toBe(true);
  }
  // A former package is no island; it is qualified by its frame, once.
  const former = spyglass.formerPackages ?? [];
  expect(former).toHaveLength(2 * (single.formerPackages?.length ?? 0));
  expect(new Set(former.map((item) => item.id)).size).toBe(former.length);
  for (const item of former) {
    expect(twinIds.some((id) => item.id.startsWith(`${id}:`))).toBe(true);
  }
  expect(Object.keys(spyglass.folderCells).every((id) => islands.has(id))).toBe(
    true
  );
  // Each island is in one frame, and an island in none is never answered
  // with another frame.
  for (const id of islandIds) {
    expect(frameOf(spyglass, id).id).toBe(id.slice(0, id.indexOf(":")));
  }
  expect(() => frameOf(spyglass, "nowhere:@x/y")).toThrow(
    "No frame of the spyglass holds the island nowhere:@x/y."
  );
});

it("keeps each frame's readings and paths bare, and its layout the one its bare ids seeded", async () => {
  const { spyglass, single } = await twins();
  expect(spyglass.frames.map((each) => [each.id, each.label])).toEqual([
    [twinIds[0], "first"],
    [twinIds[1], "second"],
  ]);
  const [frame] = single.frames;
  assert(frame);
  for (const each of spyglass.frames) {
    expect(each.readings).toEqual(frame.readings);
    expect(each.dataset).toEqual(frame.dataset);
  }
  const byFrame = islandsByFrame(spyglass);
  for (const islands of byFrame) {
    // The same islands in the same places relative to one another, and the
    // same files at the same places on them, by the same paths.
    expect(islands.map((island) => island.label)).toEqual(
      single.territories.map((territory) => territory.label)
    );
    const [first] = islands;
    const [bare] = single.territories;
    assert(first && bare);
    const dx = first.x - bare.x;
    const dy = first.y - bare.y;
    for (const [i, island] of islands.entries()) {
      const original = single.territories[i];
      assert(original);
      expect(island.x - dx).toBeCloseTo(original.x);
      expect(island.y - dy).toBeCloseTo(original.y);
      expect(island.files.map((file) => [file.path, file.x, file.y])).toEqual(
        original.files.map((file) => [file.path, file.x, file.y])
      );
    }
  }
  // Side by side, the first frame's islands west of the second's.
  const [west = [], east = []] = byFrame;
  expect(extent(west).right).toBeLessThan(extent(east).left);
});

/** The open water between each frame's rim and the next, west to east. */
function seaBetweenRims(spyglass: SpyglassData): number[] {
  const rims = archipelagoRims(spyglass);
  return rims.slice(1).map((rim, i) => {
    const west = rims[i] ?? [];
    return Math.min(...rim.map(([x]) => x)) - Math.max(...west.map(([x]) => x));
  });
}

/** The reference spyglass laid out with soft dependency layer anchors, each island's layer by its index. */
async function onRows(
  layerOf: (index: number) => number
): Promise<SpyglassData> {
  const spyglass = await referenceSpyglass();
  return relayoutSpyglass(
    {
      ...spyglass,
      packageLayers: Object.fromEntries(
        spyglass.territories.map((island, i) => [island.id, layerOf(i)])
      ),
    },
    45
  );
}

it("sets the frames side by side with open water between their rims, one rim each, preserving each frame's original composition", async () => {
  const { spyglass, single } = await twins();
  expect(archipelagoRims(spyglass)).toHaveLength(2);
  expect(archipelagoRims(single)).toHaveLength(1);
  for (const gap of seaBetweenRims(spyglass)) {
    expect(gap).toBeCloseTo(frameSea, 6);
  }
  // Frames of different dependency depths retain their own geography.
  const deep = await onRows((i) => i % 3);
  const shallow = await onRows((i) => i % 2);
  const collection = composeCollection(
    [
      qualifySpyglassData(deep, { id: twinIds[0], label: "deep" }),
      qualifySpyglassData(shallow, { id: twinIds[1], label: "shallow" }),
    ],
    []
  );
  for (const [frame, originals] of [
    [islandsByFrame(collection)[0] ?? [], deep.territories],
    [islandsByFrame(collection)[1] ?? [], shallow.territories],
  ]) {
    const dx = (frame?.[0]?.x ?? 0) - (originals?.[0]?.x ?? 0);
    const dy = (frame?.[0]?.y ?? 0) - (originals?.[0]?.y ?? 0);
    for (const [i, island] of (frame ?? []).entries()) {
      expect(island.x - dx).toBeCloseTo(originals?.[i]?.x ?? Number.NaN);
      expect(island.y - dy).toBeCloseTo(originals?.[i]?.y ?? Number.NaN);
    }
  }
  for (const gap of seaBetweenRims(collection)) {
    expect(gap).toBeCloseTo(frameSea, 6);
  }
});

it("names a collection's island with its frame's label, and a single workspace's by its name alone", async () => {
  const { spyglass, single } = await twins();
  const [island] = spyglass.territories;
  const [bare] = single.territories;
  assert(island && bare);
  expect(islandName(spyglass, island)).toBe(`${island.label} · first`);
  expect(islandName(single, bare)).toBe(bare.label);
});

it("merges crossings by the pair of packages they join, keeping every declaration", async () => {
  const { spyglass } = await twins();
  const [crossing] = spyglass.crossings ?? [];
  assert(crossing);
  const twice: SpyglassData = {
    ...spyglass,
    crossings: [
      crossing,
      { ...crossing, kind: "devDependencies", range: "^2.0.0" },
      { ...crossing, from: crossing.to, to: crossing.from },
    ],
  };
  const pairs = crossingPairs(twice);
  expect(pairs.map(({ from, to }) => [from, to])).toEqual([
    [crossing.from, crossing.to],
    [crossing.to, crossing.from],
  ]);
  expect(pairs[0]?.declared.map(({ kind, range }) => [kind, range])).toEqual([
    ["dependencies", "^1.0.0"],
    ["devDependencies", "^2.0.0"],
  ]);
  const { incoming, outgoing } = crossingsOf(twice, crossing.from);
  expect(outgoing.map((pair) => pair.to)).toEqual([crossing.to]);
  expect(incoming.map((pair) => pair.from)).toEqual([crossing.to]);
  // None for a single workspace.
  expect(crossingPairs({})).toEqual([]);
});

it("places each collection frame independently, retaining its original geography and open sea", async () => {
  const { spyglass } = await twins();
  const relaid: SpyglassData = relayoutSpyglass(spyglass, 80);
  const [west = [], east = []] = islandsByFrame(relaid);
  expect(west).toHaveLength(spyglass.frames[0]?.territories.length ?? -1);
  expect(extent(west).right).toBeLessThan(extent(east).left);
  // Each frame's islands are placed as its own workspace's alone would be.
  const alone = relayoutSpyglass(await referenceSpyglass(), 80);
  for (const islands of [west, east]) {
    const [first] = islands;
    const [bare] = alone.territories;
    assert(first && bare);
    const dx = first.x - bare.x;
    const dy = first.y - bare.y;
    for (const [i, island] of islands.entries()) {
      expect(island.x - dx).toBeCloseTo(alone.territories[i]?.x ?? Number.NaN);
      expect(island.y - dy).toBeCloseTo(alone.territories[i]?.y ?? Number.NaN);
    }
  }
  // Still apart by their rims.
  for (const gap of seaBetweenRims(relaid)) {
    expect(gap).toBeCloseTo(frameSea, 6);
  }
});

/** The viewer's fetch, answering paths under `./data/` as given. */
function stubData(answer: (path: string) => Response) {
  const fetch = vi.fn((url: string) =>
    Promise.resolve(answer(url.replace("./data/", "")))
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const notFound = () => new Response(null, { status: 404 });

it("reads a collection's manifest only when the data root holds no dataset, and says no dataset when neither is there", async () => {
  const fetch = stubData(notFound);
  await expect(loadSpyglass()).rejects.toThrow(
    "No dataset found. Run spyglass scan to save one."
  );
  await expect(loadSpyglass()).rejects.toBeInstanceOf(DatasetNotFoundError);
  expect(fetch.mock.calls.map(([url]) => url)).toContain(
    "./data/collection-manifest.json"
  );
});

it("shows a dataset it cannot parse, or a server's failure, at the data root, and never tries the collection's manifest then", async () => {
  for (const answer of [
    () => new Response("<html>", { status: 200 }),
    () => new Response("down", { status: 500 }),
  ]) {
    const fetch = stubData((path) =>
      path === "manifest.json" ? answer() : notFound()
    );
    await expect(loadSpyglass()).rejects.toThrow();
    expect(fetch.mock.calls.map(([url]) => url)).not.toContain(
      "./data/collection-manifest.json"
    );
  }
});

it("waits while a workspace is swapped, telling why, and then reads the collection's manifest", async () => {
  let attempts = 0;
  const manifest = {
    ambiguous: [],
    crossings: [],
    schemaVersion: 1,
    workspaces: [],
  };
  stubData(() => {
    attempts += 1;
    return attempts < 3
      ? new Response("Workspace /p: being saved", {
          headers: { "Retry-After": "0" },
          status: 503,
        })
      : Response.json(manifest);
  });
  const reasons: string[] = [];
  await expect(
    readCollectionManifest({ onWait: (reason) => reasons.push(reason) })
  ).resolves.toEqual(manifest);
  expect(reasons).toEqual([
    "Workspace /p: being saved",
    "Workspace /p: being saved",
  ]);
});

it("refuses a collection manifest of another schema version, and one it cannot parse", async () => {
  stubData(() => Response.json({ schemaVersion: 9 }));
  await expect(readCollectionManifest()).rejects.toThrow(
    "Spyglass reads collection manifest schema version 1; this one has version 9."
  );
  stubData(() => new Response("{", { status: 200 }));
  await expect(readCollectionManifest()).rejects.toThrow(
    "Could not parse collection-manifest.json."
  );
});

/** A collection of one workspace, `platform`, whose dataset is answered by `dataset`. */
function oneWorkspace(dataset: (path: string) => Response) {
  return stubData((path) => {
    if (path === "collection-manifest.json") {
      return Response.json({
        ambiguous: [],
        crossings: [],
        schemaVersion: 1,
        workspaces: [
          {
            dataset: "aaaaaaaaaaaa/",
            generatedAt: "2026-10-11T00:00:00.000Z",
            id: "aaaaaaaaaaaa",
            label: "platform",
            packages: [],
          },
        ],
      });
    }
    return path.startsWith("aaaaaaaaaaaa/")
      ? dataset(path.slice("aaaaaaaaaaaa/".length))
      : notFound();
  });
}

it("says a collection's workspace whose dataset is gone is being saved, by its label", async () => {
  oneWorkspace(notFound);
  await expect(loadSpyglass()).rejects.toThrow(
    "Workspace platform is being saved; reload in a moment."
  );
});

it("names a collection's workspace by its label in any other failure", async () => {
  oneWorkspace(() => Response.json({ generatedAt: "x", schemaVersion: 3 }));
  await expect(loadSpyglass()).rejects.toThrow(
    "Workspace platform: Spyglass reads dataset schema version 5; this dataset has version 3. Run spyglass scan to save it again."
  );
});
