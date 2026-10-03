import { afterEach, expect, it, vi } from "vitest";
import { loadInternals } from "../../src/web/load-internals";

afterEach(() => vi.unstubAllGlobals());

function surveyFetch() {
  const pkg = { id: "example", root: "packages/example" };
  return vi.fn((url: string) => {
    let body: object = { churn: { available: false, reason: "not-collected" } };
    if (url.endsWith("manifest.json")) {
      body = {
        files: { moduleIndex: "index.json" },
        generatedAt: "survey",
        packages: [{ id: "example", report: "packages/example.json" }],
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
