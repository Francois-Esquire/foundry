import { resolve } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { expect } from "vitest";
import { serveStatic } from "./static-site";

// Drives the built scan page in a real Chromium: Workers are made to throw
// before any page script runs (so a passing scan proves the direct mode),
// every request is recorded, and the page's status lines, long tasks and
// errors are collected for assertions and the measurements a run logs.

/**
 * Where the built page is served from, by `SPYGLASS_SITE`: `foundry.sh`
 * (the default) is the website's whole production output, which serves the
 * page at /spyglass/scan/; `docs` is the built documentation site, which
 * GitHub Pages mounts at /foundry/; `package` is this package's own
 * dist/scan, the files both sites copy, at the website's route. Each site
 * is built before the suite: `turbo run test:browser` builds this package
 * and the website; `docs` needs `bun run docs:build` first.
 */
const TARGETS = {
  docs: {
    base: "/foundry/",
    directory: "apps/documentation/dist",
    page: "spyglass/scan/",
  },
  "foundry.sh": {
    base: "/",
    directory: "apps/website/dist",
    page: "spyglass/scan/",
  },
  package: {
    base: "/spyglass/scan/",
    directory: "apps/spyglass/dist/scan",
    page: "",
  },
} as const;

type Target = keyof typeof TARGETS;

function target(): (typeof TARGETS)[Target] {
  const name = process.env.SPYGLASS_SITE || "foundry.sh";
  if (!Object.hasOwn(TARGETS, name)) {
    throw new Error(
      `SPYGLASS_SITE=${name} is not a site; use one of ${Object.keys(TARGETS).join(", ")}.`
    );
  }
  return TARGETS[name as Target];
}

const SITE = target();

/** The page's path on the site being served. */
export const SCAN_PATH = `${SITE.base}${SITE.page}`;

/** Whether the served site is foundry.sh's whole production output. */
export const SERVES_WEBSITE = SITE === TARGETS["foundry.sh"];

const INIT = `
(() => {
  window.__workerAttempts = 0;
  const refuse = function () {
    window.__workerAttempts += 1;
    throw new Error("Workers are disabled in this acceptance test.");
  };
  Object.defineProperty(window, "Worker", { configurable: false, value: refuse });
  Object.defineProperty(window, "SharedWorker", { configurable: false, value: refuse });
  window.__longTasks = [];
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__longTasks.push(Math.round(entry.duration));
      }
    }).observe({ buffered: true, type: "longtask" });
  } catch {}
  window.__statuses = [];
  const record = () => {
    const line = document.querySelector(".spyglass-scan-status p")?.textContent ?? "";
    const statuses = window.__statuses;
    if (line !== "" && statuses[statuses.length - 1] !== line) {
      statuses.push(line);
    }
  };
  document.addEventListener("DOMContentLoaded", () => {
    new MutationObserver(record).observe(document.body, {
      characterData: true,
      childList: true,
      subtree: true,
    });
  });
})();
`;

export interface ScanPage {
  context: BrowserContext;
  /** Uncaught errors and console errors the page raised. */
  errors: string[];
  page: Page;
  /** `x-ratelimit-remaining` of the last GitHub API response seen. */
  rateRemaining: () => string | undefined;
  /** Every request the page made, by URL, in order. */
  requests: string[];
}

export async function openScanPage(
  browser: Browser,
  origin: string,
  query = ""
): Promise<ScanPage> {
  const context = await browser.newContext({
    viewport: { height: 800, width: 1280 },
  });
  await context.addInitScript(INIT);
  const page = await context.newPage();
  const requests: string[] = [];
  const errors: string[] = [];
  let remaining: string | undefined;
  page.on("request", (request) => requests.push(request.url()));
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("response", (response) => {
    if (response.url().startsWith("https://api.github.com/")) {
      remaining = response.headers()["x-ratelimit-remaining"] ?? remaining;
    }
  });
  await page.goto(`${origin}${SCAN_PATH}${query}`);
  return { context, errors, page, rateRemaining: () => remaining, requests };
}

async function fill(
  page: Page,
  fields: { dir?: string; ref?: string; repo: string }
): Promise<void> {
  await page.getByLabel("Public GitHub repository").fill(fields.repo);
  await page
    .getByLabel("Branch, tag or commit (optional)")
    .fill(fields.ref ?? "");
  await page.getByLabel("Directory (optional)").fill(fields.dir ?? "");
}

export async function scan(
  page: Page,
  fields: { dir?: string; ref?: string; repo: string }
): Promise<void> {
  await fill(page, fields);
  await page.getByRole("button", { exact: true, name: "Scan" }).click();
}

/** The result panel, once a scan has published. */
export const resultPanel = (page: Page) =>
  page.getByRole("complementary", { name: "Browser scan" });

export const alert = (page: Page) => page.getByRole("alert");

/** The status lines the page showed, in order. */
export const statuses = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __statuses: string[] }).__statuses
  );

/** What the page measured about itself. */
export const measurements = (page: Page) =>
  page.evaluate(() => {
    const own = window as unknown as {
      __longTasks: number[];
      __workerAttempts: number;
    };
    const { memory } = performance as unknown as {
      memory?: { usedJSHeapSize: number };
    };
    const asset = performance
      .getEntriesByType("resource")
      .find((entry) => entry.name.endsWith("/analysis/spyglass-analysis.js")) as
      | PerformanceResourceTiming
      | undefined;
    return {
      assetBytes: asset?.decodedBodySize,
      assetLoadMs: asset === undefined ? undefined : Math.round(asset.duration),
      assetTransferBytes: asset?.transferSize,
      heapMB:
        memory === undefined
          ? undefined
          : Math.round(memory.usedJSHeapSize / 1e6),
      longestTaskMs: Math.max(0, ...own.__longTasks),
      longTasks: own.__longTasks.length,
      workerAttempts: own.__workerAttempts,
    };
  });

/** Origins of every request, with the page's own as `site`. */
function originsOf(requests: readonly string[], site: string): string[] {
  return [
    ...new Set(
      requests.map((url) => {
        const { origin } = new URL(url);
        return origin === site ? "site" : origin;
      })
    ),
  ].sort();
}

/** Fails unless the page made no request beyond its site and GitHub's two data hosts. */
export function expectOnlyOfficialOrigins(
  requests: readonly string[],
  site: string
): void {
  for (const origin of originsOf(requests, site)) {
    expect([
      "site",
      "https://api.github.com",
      "https://raw.githubusercontent.com",
    ]).toContain(origin);
  }
  // Same-origin requests are the built site's static files only.
  for (const url of requests.filter((u) => new URL(u).origin === site)) {
    expect(new URL(url).pathname.startsWith(SCAN_PATH)).toBe(true);
  }
}

/** The built scan page, on the site `SPYGLASS_SITE` names (see `TARGETS`). */
export function serveScanSite() {
  return serveStatic(
    resolve(import.meta.dirname, "../../../../..", SITE.directory),
    SITE.base
  );
}
