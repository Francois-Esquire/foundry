import { afterEach, expect, it, vi } from "vitest";
import { loadInternals } from "../../src/web/load-internals";

afterEach(() => vi.unstubAllGlobals());

const scanned = {
  id: "example",
  internals: "internals/example.json",
  report: "packages/example.json",
  status: "complete",
};

function surveyFetch(entry: object = scanned) {
  const pkg = { id: "example", root: "packages/example" };
  return vi.fn((url: string) => {
    let body: object = { churn: { available: false, reason: "not-collected" } };
    if (url.endsWith("manifest.json")) {
      body = {
        files: { moduleIndex: "index.json" },
        generatedAt: "survey",
        packages: [entry],
      };
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
    loadInternals("example", "survey", new AbortController().signal)
  ).rejects.toThrow(
    "This dataset was saved without internals. Run atlas scan to include them."
  );
});

it("says a package that failed analysis has no internals", async () => {
  vi.stubGlobal(
    "fetch",
    surveyFetch({ error: "boom", id: "example", status: "failed" })
  );
  await expect(
    loadInternals("example", "survey", new AbortController().signal)
  ).rejects.toThrow(
    "Atlas could not analyze this package, so it has no internals."
  );
});

it("says when the dataset has no such package", async () => {
  vi.stubGlobal("fetch", surveyFetch());
  await expect(
    loadInternals("missing", "survey", new AbortController().signal)
  ).rejects.toThrow("The dataset has no package named missing.");
});
