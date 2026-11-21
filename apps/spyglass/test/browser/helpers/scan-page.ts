import { resolve } from "node:path";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from "playwright-core";
import { expect } from "vitest";
import { serveStatic } from "./static-site";

export const SCAN_PATH = "/spyglass/scan/";

const ENGINE_PATH = /^\/_astro\/spyglass-analysis\.[\w-]+\.js$/;

export const isEngine = (url: string) =>
  ENGINE_PATH.test(new URL(url).pathname);

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

export function launchChromium(): Promise<Browser> {
  return chromium.launch({ channel: "chromium" });
}

export async function expectWebGpuAdapter(
  browser: Browser,
  origin: string
): Promise<{ architecture: string; browser: string; vendor: string }> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${origin}${SCAN_PATH}`);
    const { adapter, api } = await page.evaluate(async () => {
      const { gpu } = navigator as unknown as {
        gpu?: {
          requestAdapter: () => Promise<{
            info: {
              architecture: string;
              isFallbackAdapter?: boolean;
              vendor: string;
            };
          } | null>;
        };
      };
      const found = await gpu?.requestAdapter();
      return {
        adapter: found
          ? {
              architecture: found.info.architecture,
              fallback: found.info.isFallbackAdapter === true,
              vendor: found.info.vendor,
            }
          : null,
        api: gpu !== undefined,
      };
    });
    if (adapter === null || adapter.fallback) {
      throw new Error(
        `This Chromium (${browser.version()}) has no hardware WebGPU adapter ` +
          `(${JSON.stringify({ adapter, api })}), so the map cannot draw. ` +
          "Run the suite on a machine with a GPU Chromium can use."
      );
    }
    return {
      architecture: adapter.architecture,
      browser: browser.version(),
      vendor: adapter.vendor,
    };
  } finally {
    await context.close();
  }
}

export interface ScanPage {
  context: BrowserContext;

  errors: string[];
  page: Page;

  rateRemaining: () => string | undefined;

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
    if (new URL(response.url()).origin === origin && response.status() >= 400) {
      errors.push(`${response.status()} ${response.url()}`);
    }
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

export const resultPanel = (page: Page) =>
  page.getByRole("complementary", { name: "Browser scan" });

export const alert = (page: Page) => page.getByRole("alert");

export const statuses = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __statuses: string[] }).__statuses
  );

export const measurements = (page: Page) =>
  page.evaluate((enginePath) => {
    const own = window as unknown as {
      __longTasks: number[];
      __workerAttempts: number;
    };
    const { memory } = performance as unknown as {
      memory?: { usedJSHeapSize: number };
    };
    const asset = performance
      .getEntriesByType("resource")
      .find((entry) =>
        new RegExp(enginePath).test(new URL(entry.name).pathname)
      ) as PerformanceResourceTiming | undefined;
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
  }, ENGINE_PATH.source);

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

const isPageFile = (path: string) =>
  path === SCAN_PATH || path.startsWith("/_astro/") || path === "/favicon.svg";

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

  for (const url of requests.filter((u) => new URL(u).origin === site)) {
    expect(isPageFile(new URL(url).pathname), url).toBe(true);
  }
}

export function serveScanSite() {
  return serveStatic(resolve(import.meta.dirname, "../../../../website/dist"));
}
