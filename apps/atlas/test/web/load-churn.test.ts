import { afterEach, expect, it, vi } from "vitest";
import { loadInternals } from "../../src/web/load-internals";

afterEach(() => vi.unstubAllGlobals());

const scanned = {
  id: "example",
  internals: "internals/example.json",
  report: "packages/example.json",
  status: "complete",
};

/** Serves one package's dataset; each manifest read takes the next save time, the last one repeating. */
function surveyFetch(entry: object = scanned, savedAt = ["survey"]) {
  const pkg = { id: "example", root: "packages/example" };
  let manifestReads = 0;
  return vi.fn((url: string) => {
    let body: object = { churn: { available: false, reason: "not-collected" } };
    if (url.endsWith("manifest.json")) {
      body = {
        files: { moduleIndex: "index.json" },
        generatedAt: savedAt[Math.min(manifestReads, savedAt.length - 1)],
        packages: [entry],
        schemaVersion: 4,
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
    } else if (url.endsWith("index.json")) {
      body = { modules: [] };
    }
    return Promise.resolve(Response.json(body));
  });
}

it("does not fetch the full package report for ordinary belonging exploration", async () => {
  const fetch = surveyFetch();
  vi.stubGlobal("fetch", fetch);
  const result = await loadInternals(
    "example",
    undefined,
    "survey",
    new AbortController().signal
  );
  expect(result.churn).toBeUndefined();
  expect(fetch.mock.calls.some(([url]) => url.includes("packages/"))).toBe(
    false
  );
});

it("loads recorded change only on request and preserves unavailable history", async () => {
  const fetch = surveyFetch();
  vi.stubGlobal("fetch", fetch);
  const result = await loadInternals(
    "example",
    undefined,
    "survey",
    new AbortController().signal,
    true
  );
  expect(result.churn).toEqual({ available: false, reason: "not-collected" });
  expect(fetch.mock.calls.some(([url]) => url.includes("packages/"))).toBe(
    true
  );
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
    ).rejects.toThrow(
      "A later scan replaced the dataset. Reload Atlas to see it."
    );
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
