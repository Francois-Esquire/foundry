import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  expectOnlyOfficialOrigins,
  measurements,
  openScanPage,
  resultPanel,
  type ScanPage,
  scan,
  serveScanSite,
} from "./helpers/scan-page";

// The built scan page in real Chromium, Workers disabled, scanning real
// public repositories on GitHub at pinned commits, unauthenticated: a small
// standalone package and a multi-package workspace. Each scan spends 3 of
// GitHub's 60 API requests an hour for this network address. The page's
// own measurements (engine load, long tasks, heap) and a screenshot of each
// map are written to `<tmp>/spyglass-browser-acceptance/`.

const EVIDENCE = join(tmpdir(), "spyglass-browser-acceptance");
const READ_FILES = /Read(\d+) files/;
const MAP_MODE = /^Show (belonging|files)$/;
const TIMING = /Downloaded in [\d.]+ s, analysed in [\d.]+ s/;

const REPOSITORIES = [
  {
    commit: "3541888878c4d303a8bc2ad61815f4e048f55a5d",
    label: "standalone",
    name: "sindresorhus/ky",
  },
  {
    commit: "2f6995d5bbd3b1572d7a6cd897d2229bfc1ce8c1",
    label: "workspace",
    name: "changesets/changesets",
  },
] as const;

let browser: Browser;
let site: ReturnType<typeof serveScanSite>;
const opened: ScanPage[] = [];
const measured: Record<string, unknown> = {};

beforeAll(async () => {
  mkdirSync(EVIDENCE, { recursive: true });
  site = serveScanSite();
  browser = await chromium.launch();
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map(({ context }) => context.close()));
});

afterAll(async () => {
  writeFileSync(
    join(EVIDENCE, "measurements.json"),
    `${JSON.stringify(measured, null, 2)}\n`
  );
  await browser?.close();
  site?.stop();
});

describe.each(REPOSITORIES)(
  "scan page against GitHub: $name ($label)",
  ({ commit, label, name }) => {
    it("downloads at the pinned commit, analyses in the page and opens the viewer", async () => {
      const scanPage = await openScanPage(browser, site.origin);
      opened.push(scanPage);
      const { errors, page, requests } = scanPage;
      const started = Date.now();
      await scan(page, { ref: commit, repo: `https://github.com/${name}` });
      await expect
        .poll(() => resultPanel(page).isVisible(), { timeout: 150_000 })
        .toBe(true);
      const wallMs = Date.now() - started;

      // Only the site's own files and GitHub's two data hosts; three API calls.
      expectOnlyOfficialOrigins(requests, site.origin);
      const api = requests.filter((url) =>
        url.startsWith("https://api.github.com/")
      );
      expect(api).toEqual([
        `https://api.github.com/repos/${name}`,
        `https://api.github.com/repos/${name}/commits/${commit}`,
        `https://api.github.com/repos/${name}/git/trees/${commit}?recursive=1`,
      ]);
      const raw = requests.filter((url) =>
        url.startsWith("https://raw.githubusercontent.com/")
      );
      expect(raw.every((url) => url.includes(`/${name}/${commit}/`))).toBe(
        true
      );

      // The saved metadata, as the page shows it, names exactly that revision.
      const panel = resultPanel(page);
      await panel.getByText("What this scan could and could not see").click();
      const text = (await panel.textContent()) ?? "";
      expect(text).toContain(`${name} @ ${commit.slice(0, 7)}`);
      expect(text).toContain(`Commit${commit}`);
      expect(text).toContain(`Ref${commit}`);
      expect(text).toContain("History unavailable");
      const read = Number(READ_FILES.exec(text)?.[1]);
      expect(read).toBeGreaterThan(0);
      expect(read).toBeLessThanOrEqual(raw.length);

      // The existing viewer, mounted on the dataset's own transport, navigates.
      await expect
        .poll(() => page.locator("canvas").count())
        .toBeGreaterThan(0);
      await page.getByRole("button", { exact: true, name: "Zoom in" }).click();
      await page.getByRole("button", { name: MAP_MODE }).click();
      await page.getByRole("button", { exact: true, name: "Legend" }).click();
      await expect.poll(() => page.getByRole("dialog").isVisible()).toBe(true);
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Open chart controls" }).click();
      await page.getByRole("button", { name: "Close chart controls" }).click();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: join(EVIDENCE, `${label}.png`) });
      expect(errors).toEqual([]);

      const page_ = await measurements(page);
      expect(page_.workerAttempts).toBe(0);
      measured[name] = {
        apiRequests: api.length,
        commit,
        rateLimitRemaining: scanPage.rateRemaining(),
        rawRequests: raw.length,
        readFiles: read,
        timing: TIMING.exec(text)?.[0],
        wallMs,
        ...page_,
      };
    });
  }
);
