import { afterEach, expect, it, vi } from "vitest";
import { loadInternals } from "../../src/web/load-internals";

afterEach(() => vi.unstubAllGlobals());

const scanned = {
  id: "example",
  internals: "internals/example.json",
  report: "packages/example.json",
  status: "complete",
};

const changedFiles = [
  {
    commitPercentile: 0.95,
    commits: 12,
    file: "packages/example/src/a.ts",
    linesChanged: 80,
  },
];
const history = {
  analyzedAt: "2026-10-01T00:00:00.000Z",
  historyComplete: true,
};
const frequentChange = {
  gate: { eligibleKinds: ["source"], minCommitPercentile: 0.9 },
  missing: ["other"],
  packages: [{ files: changedFiles, history, id: "example" }],
};

/**
 * Serves one package's dataset; each manifest read takes the next save time,
 * the last one repeating. `lens` is the frequent-change lens, or `null` for
 * a dataset saved before it.
 */
function surveyFetch(
  entry: object = scanned,
  savedAt = ["survey"],
  lens: object | null = frequentChange
) {
  const pkg = { id: "example", root: "packages/example" };
  let manifestReads = 0;
  return vi.fn((url: string) => {
    let body: object | undefined;
    if (url.endsWith("manifest.json")) {
      body = {
        files: { moduleIndex: "index.json" },
        generatedAt: savedAt[Math.min(manifestReads, savedAt.length - 1)],
        lenses: lens
          ? {
              "frequent-change": {
                file: "lenses/frequent-change.json",
                schemaVersion: 1,
              },
            }
          : {},
        packages: [entry],
        schemaVersion: 5,
      };
      manifestReads += 1;
    } else if (url.includes("internals/")) {
      body = {
        locality: { package: pkg },
        primitives: {},
        responsibilities: { package: pkg },
        review: {},
        rewiring: {},
        topology: { modules: [], package: pkg },
      };
    } else if (url.endsWith("lenses/frequent-change.json")) {
      body = lens ?? undefined;
    } else if (url.endsWith("index.json")) {
      body = { modules: [] };
    }
    return Promise.resolve(
      body ? Response.json(body) : new Response(null, { status: 404 })
    );
  });
}

const read = (
  fetch: ReturnType<typeof surveyFetch>,
  recordedChange = false
) => {
  vi.stubGlobal("fetch", fetch);
  return loadInternals(
    "example",
    undefined,
    "survey",
    new AbortController().signal,
    recordedChange
  );
};

it("reads no recorded change for ordinary belonging exploration", async () => {
  const fetch = surveyFetch();
  const result = await read(fetch);
  expect(result.frequentChange).toBeUndefined();
  expect(fetch.mock.calls.some(([url]) => url.includes("lenses/"))).toBe(false);
});

it("reads recorded change from the frequent-change lens on request, never the package report", async () => {
  const fetch = surveyFetch();
  const result = await read(fetch, true);
  expect(result.frequentChange).toEqual({
    available: true,
    files: changedFiles,
    gate: frequentChange.gate,
    history,
  });
  expect(fetch.mock.calls.some(([url]) => url.includes("packages/"))).toBe(
    false
  );
});

it("says a package the lens lists without history has no recorded change", async () => {
  const lens = { ...frequentChange, missing: ["example"], packages: [] };
  const result = await read(surveyFetch(scanned, ["survey"], lens), true);
  expect(result.frequentChange).toEqual({
    available: false,
    reason: "no-history",
  });
});

it("says a dataset saved before the lens has no recorded change to show", async () => {
  const result = await read(surveyFetch(scanned, ["survey"], null), true);
  expect(result.frequentChange).toEqual({
    available: false,
    reason: "not-saved",
  });
});

it("says when the dataset was saved without internals", async () => {
  const { internals: _internals, ...workspaceOnly } = scanned;
  vi.stubGlobal("fetch", surveyFetch(workspaceOnly));
  await expect(
    loadInternals("example", undefined, "survey", new AbortController().signal)
  ).rejects.toThrow(
    "The dataset was saved without internals for example. Run atlas scan to include them."
  );
});

it("says a package that failed analysis has no internals", async () => {
  vi.stubGlobal(
    "fetch",
    surveyFetch({ error: "boom", id: "example", status: "failed" })
  );
  await expect(
    loadInternals("example", undefined, "survey", new AbortController().signal)
  ).rejects.toThrow("Atlas could not analyze example, so it has no internals.");
});

it("says when the dataset has no such package", async () => {
  vi.stubGlobal("fetch", surveyFetch());
  await expect(
    loadInternals("missing", undefined, "survey", new AbortController().signal)
  ).rejects.toThrow("The dataset has no package named missing.");
});

it("reads the manifest to start and again to close, and nothing it does not need", async () => {
  const fetch = surveyFetch();
  vi.stubGlobal("fetch", fetch);
  await loadInternals(
    "example",
    undefined,
    "survey",
    new AbortController().signal
  );
  const urls = fetch.mock.calls.map(([url]) => url);
  expect(urls.at(0)).toBe("./data/manifest.json");
  expect(urls.at(-1)).toBe("./data/manifest.json");
  // The two files between are read together, in either order.
  expect(urls.slice(1, -1).sort()).toEqual([
    "./data/index.json",
    "./data/internals/example.json",
  ]);
});

it.each([
  ["before it reads", ["later"]],
  ["while it reads", ["survey", "later"]],
])(
  "refuses evidence when a later scan replaced the dataset %s",
  async (_when, savedAt) => {
    vi.stubGlobal("fetch", surveyFetch(scanned, savedAt));
    await expect(
      loadInternals(
        "example",
        undefined,
        "survey",
        new AbortController().signal
      )
    ).rejects.toThrow("A later scan replaced this dataset. Reload to see it.");
  }
);

it("says when the saved internals are incomplete", async () => {
  vi.stubGlobal("fetch", surveyFetch({ ...scanned, id: "other" }));
  await expect(
    loadInternals("other", undefined, "survey", new AbortController().signal)
  ).rejects.toThrow(
    "The dataset's internals for other are incomplete. Run atlas scan again."
  );
});
