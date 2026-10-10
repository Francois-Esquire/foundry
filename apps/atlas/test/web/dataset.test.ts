import { afterEach, expect, it, vi } from "vitest";
import { viewerDataset } from "../../src/web/dataset";
import { memoryTransport, stubFetch } from "../helpers/dataset-transport";

const manifest = {
  files: { workspace: "workspace.json" },
  generatedAt: "2026-10-10T00:00:00.000Z",
  packages: [{ id: "@s/a", report: "packages/@s__a.json", status: "complete" }],
  schemaVersion: 4,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

it.each([
  "http://localhost:4173/",
  "http://localhost:4173/foundry/atlas/examples/foundry/",
])("reads the dataset served beneath %s", async (base) => {
  stubFetch(
    memoryTransport({
      "manifest.json": manifest,
      "packages/@s__a.json": { churn: { available: false } },
    }),
    { base }
  );
  await expect(viewerDataset().packageReport("@s/a")).resolves.toEqual({
    churn: { available: false },
  });
});

it("asks every time, and stops when the viewer does", async () => {
  const fetch = stubFetch(memoryTransport({ "manifest.json": manifest }));
  const { signal } = new AbortController();
  await viewerDataset({ signal }).manifest();
  expect(fetch).toHaveBeenCalledWith("./data/manifest.json", {
    cache: "no-store",
    signal,
  });
});

it("treats a file the server does not have as missing from the dataset", async () => {
  stubFetch(memoryTransport({ "manifest.json": manifest }));
  await expect(viewerDataset().workspaceReport()).rejects.toThrow(
    "The dataset is missing workspace.json. Run atlas scan again."
  );
  stubFetch(memoryTransport({}));
  await expect(viewerDataset().manifest()).rejects.toThrow(
    "No dataset found. Run atlas scan to save one."
  );
});

it("names the file the server failed to serve", async () => {
  stubFetch(memoryTransport({ "manifest.json": manifest }), { status: 500 });
  await expect(viewerDataset().workspaceReport()).rejects.toThrow(
    "Could not load workspace.json (500)."
  );
});

it("names the file the server served that is not JSON", async () => {
  vi.stubGlobal("fetch", () => Promise.resolve(new Response("<html>")));
  await expect(viewerDataset().manifest()).rejects.toThrow(
    "Could not parse manifest.json."
  );
});
