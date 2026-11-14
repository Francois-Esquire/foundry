import type { Browser } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FakeRepository } from "../lib/helpers/github-fake";
import { deferred, fakeGitHub } from "../lib/helpers/github-fake";
import { routeGitHub } from "./helpers/github-route";
import {
  alert,
  expectOnlyOfficialOrigins,
  launchChromium,
  openScanPage,
  resultPanel,
  SCAN_PATH,
  type ScanPage,
  SERVES_WEBSITE,
  scan,
  serveScanSite,
  statuses,
} from "./helpers/scan-page";

// The built scan page in real Chromium, with Workers disabled, against a
// deterministic GitHub answered through the browser's own request routing:
// lifecycle (progress, cancel, replacement, retry, reset, reload) and every
// refusal a person can meet, at no cost to GitHub's rate limit. The live
// suite beside this one scans real repositories.

const COMMIT = "1111111111111111111111111111111111111111";
const COUNT = /\d+ of \d+/;
const API = /^https:\/\/api\.github\.com\//;
const ANALYSIS_STEP = /Preparing|Analysing|Deriving|Assembling/;

/** A small Bun-style workspace: two packages, one importing the other. */
const workspace = (name: string): FakeRepository => ({
  commits: {
    [COMMIT]: {
      "package.json": JSON.stringify({
        name,
        private: true,
        workspaces: ["packages/*"],
      }),
      "packages/core/package.json": JSON.stringify({
        exports: "./src/index.ts",
        name: `@${name}/core`,
      }),
      "packages/core/src/index.ts":
        'export { total } from "./sum";\nexport const label = "core";\n',
      "packages/core/src/sum.ts":
        "export const total = (values: number[]) => values.reduce((a, b) => a + b, 0);\n",
      "packages/web/package.json": JSON.stringify({
        dependencies: { [`@${name}/core`]: "workspace:*" },
        name: `@${name}/web`,
      }),
      "packages/web/src/index.ts": `import { label, total } from "@${name}/core";\nexport const view = () => \`\${label}: \${total([1, 2])}\`;\n`,
      "README.md": "# fixture\n",
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
    },
  },
  defaultBranch: "main",
  refs: { main: COMMIT },
});

let browser: Browser;
let site: ReturnType<typeof serveScanSite>;
const opened: ScanPage[] = [];

beforeAll(async () => {
  site = serveScanSite();
  browser = await launchChromium();
});

// Each page draws the map continuously; one open at a time keeps timing honest.
afterEach(async () => {
  await Promise.all(opened.splice(0).map(({ context }) => context.close()));
});

afterAll(async () => {
  await browser?.close();
  site?.stop();
});

async function open(
  repositories: Record<string, FakeRepository> = {
    "octo/demo": workspace("demo"),
    "octo/other": workspace("other"),
  },
  query = ""
) {
  const github = fakeGitHub(repositories);
  const scanPage = await openScanPage(browser, site.origin, query);
  opened.push(scanPage);
  await routeGitHub(scanPage.page, github);
  return { github, ...scanPage };
}

const githubRequests = (requests: readonly string[]) =>
  requests.filter((url) => !url.startsWith("http://127.0.0.1"));

describe("scan page (mocked GitHub, real Chromium, no Worker)", () => {
  it("downloads, analyses and opens the result in the viewer", async () => {
    const { errors, page, requests } = await open();
    await scan(page, { repo: "https://github.com/octo/demo" });
    await expect
      .poll(() => resultPanel(page).isVisible(), { timeout: 60_000 })
      .toBe(true);
    const panel = resultPanel(page);
    expect(await panel.textContent()).toContain(
      `octo/demo @ ${COMMIT.slice(0, 7)}`
    );
    await panel.getByText("What this scan could and could not see").click();
    const details = await panel.textContent();
    expect(details).toContain(COMMIT);
    expect(details).toContain("default branch (main)");
    expect(details).toContain("History unavailable");
    expect(details).toContain("1 files outside the analysis inputs");
    // The viewer mounted over the in-memory dataset and draws.
    await expect.poll(() => page.locator("canvas").count()).toBeGreaterThan(0);
    await page.getByRole("button", { exact: true, name: "Legend" }).click();
    await expect.poll(() => page.getByRole("dialog").isVisible()).toBe(true);
    await page.keyboard.press("Escape");
    await expect.poll(() => page.getByRole("dialog").isVisible()).toBe(false);
    expect(
      await statuses(page).then((lines) =>
        lines.map((line) => line.replace(COUNT, "N of M"))
      )
    ).toEqual(
      expect.arrayContaining([
        "Resolving the commit on GitHub…",
        "Listing the repository's files…",
        "Downloading files from GitHub: N of M",
        "Preparing the TypeScript program and module graph…",
      ])
    );
    expectOnlyOfficialOrigins(requests, site.origin);
    // The engine is the one asset beside the page, loaded once by URL.
    expect(requests.filter((url) => url.includes("/analysis/"))).toEqual([
      `${site.origin}${SCAN_PATH}analysis/spyglass-analysis.js`,
    ]);
    // Three API calls, then raw files at the resolved commit only.
    const api = requests.filter((url) =>
      url.startsWith("https://api.github.com/")
    );
    expect(api).toHaveLength(3);
    const raw = requests.filter((url) =>
      url.startsWith("https://raw.githubusercontent.com/")
    );
    expect(raw.length).toBeGreaterThan(0);
    expect(raw.every((url) => url.includes(`/octo/demo/${COMMIT}/`))).toBe(
      true
    );
    expect(errors).toEqual([]);
  });

  it("refuses an unsupported URL at once, loading nothing", async () => {
    const { page, requests } = await open();
    await scan(page, { repo: "https://gitlab.com/octo/demo" });
    await expect
      .poll(() => alert(page).textContent())
      .toContain("only public repositories on github.com are supported");
    expect(githubRequests(requests)).toEqual([]);
    expect(requests.some((url) => url.includes("/analysis/"))).toBe(false);
  });

  it("names a ref that does not exist", async () => {
    const { page } = await open();
    await scan(page, {
      ref: "no-such-branch",
      repo: "https://github.com/octo/demo",
    });
    await expect
      .poll(() => alert(page).textContent(), { timeout: 60_000 })
      .toContain(
        'No commit was found for ref "no-such-branch" of github.com/octo/demo.'
      );
    expect(await alert(page).textContent()).toContain("Ref not found");
  });

  it("names a missing repository without claiming it is private", async () => {
    const { page } = await open();
    await scan(page, { repo: "https://github.com/octo/missing" });
    await expect
      .poll(() => alert(page).textContent(), { timeout: 60_000 })
      .toContain(
        "Without credentials GitHub answers the same for a private repository"
      );
  });

  it("reports GitHub's rate limit with its reset, and a retry succeeds once it lifts", async () => {
    const { github, page } = await open();
    // Lifted below, before the retry.
    const limit = new Set(["rate"]);
    github.hook(() =>
      limit.has("rate")
        ? new Response("{}", {
            headers: {
              "content-type": "application/json",
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": "1794203326",
            },
            status: 403,
          })
        : undefined
    );
    await scan(page, { repo: "https://github.com/octo/demo" });
    await expect
      .poll(() => alert(page).textContent(), { timeout: 60_000 })
      .toContain("GitHub's rate limit was reached");
    expect(await alert(page).textContent()).toContain(
      "it resets at 2026-11-09T05:48:46.000Z"
    );
    limit.delete("rate");
    await page.getByRole("button", { exact: true, name: "Try again" }).click();
    await expect
      .poll(() => resultPanel(page).isVisible(), { timeout: 60_000 })
      .toBe(true);
  });

  it("reports a blocked or failed network request without falling back to anything", async () => {
    const { page, requests } = await open();
    await page.route(API, (route) => route.abort("failed"));
    await scan(page, { repo: "https://github.com/octo/demo" });
    await expect
      .poll(() => alert(page).textContent(), { timeout: 60_000 })
      .toContain("or the response was blocked cross-origin");
    expectOnlyOfficialOrigins(requests, site.origin);
  });

  it("refuses a repository over the file limit before downloading any file", async () => {
    const files: Record<string, string> = { "package.json": "{}" };
    for (let index = 0; index < 5001; index += 1) {
      files[`src/m${index}.ts`] = `export const v${index} = ${index};\n`;
    }
    const { page, requests } = await open({
      "octo/huge": {
        commits: { [COMMIT]: files },
        defaultBranch: "main",
        refs: { main: COMMIT },
      },
    });
    await scan(page, { repo: "https://github.com/octo/huge" });
    await expect
      .poll(() => alert(page).textContent(), { timeout: 60_000 })
      .toContain("over the provisional 5000-file limit");
    expect(
      requests.some((url) =>
        url.startsWith("https://raw.githubusercontent.com/")
      )
    ).toBe(false);
  });

  it("cancels during download; late responses publish and report nothing", async () => {
    const { github, page } = await open();
    const held = deferred<void>();
    github.hook(async (url) => {
      if (url.host === "raw.githubusercontent.com") {
        await held.promise;
      }
    });
    await scan(page, { repo: "https://github.com/octo/demo" });
    await expect
      .poll(() => page.getByRole("status").textContent(), { timeout: 60_000 })
      .toContain("Downloading files from GitHub");
    await page.getByRole("button", { exact: true, name: "Cancel" }).click();
    await expect
      .poll(() => page.getByRole("status").textContent())
      .toContain("Scan cancelled. Nothing was kept.");
    const before = await statuses(page);
    held.resolve();
    await page.waitForTimeout(1500);
    expect(await statuses(page)).toEqual(before);
    expect(await resultPanel(page).count()).toBe(0);
  });

  it("cancels during analysis, between analysis steps", async () => {
    const { page } = await open();
    // Pressed from inside the page the moment analysis is reported, since
    // analysis holds the main thread between its steps.
    await page.evaluate(() => {
      const observer = new MutationObserver(() => {
        const line =
          document.querySelector(".spyglass-scan-status p")?.textContent ?? "";
        const steps = ["Preparing", "Analysing", "Deriving", "Assembling"];
        if (steps.some((step) => line.includes(step))) {
          observer.disconnect();
          (window as unknown as { __cancelledAt: string }).__cancelledAt = line;
          for (const button of document.querySelectorAll("button")) {
            if (button.textContent === "Cancel") {
              button.click();
            }
          }
        }
      });
      observer.observe(document.body, {
        characterData: true,
        childList: true,
        subtree: true,
      });
    });
    await scan(page, { repo: "https://github.com/octo/demo" });
    await expect
      .poll(() => page.getByRole("status").textContent(), { timeout: 60_000 })
      .toContain("Scan cancelled. Nothing was kept.");
    expect(
      await page.evaluate(
        () => (window as unknown as { __cancelledAt: string }).__cancelledAt
      )
    ).toMatch(ANALYSIS_STEP);
    await page.waitForTimeout(1500);
    expect(await resultPanel(page).count()).toBe(0);
  });

  for (const refused of [
    "https://gitlab.com/octo/demo",
    "https://example.com/repository",
  ]) {
    it(`a refused URL (${refused}) submitted mid-scan replaces nothing; the scan finishes`, async () => {
      const { github, page } = await open();
      const held = deferred<void>();
      github.hook(async (url) => {
        if (url.host === "raw.githubusercontent.com") {
          await held.promise;
        }
      });
      await scan(page, { repo: "https://github.com/octo/demo" });
      await expect
        .poll(() => page.getByRole("status").textContent(), {
          timeout: 60_000,
        })
        .toContain("Downloading files from GitHub");
      await scan(page, { repo: refused });
      await expect
        .poll(() => alert(page).textContent())
        .toContain("That repository URL is not supported");
      // The running scan is still the page's, and still cancellable.
      expect(await page.getByRole("status").textContent()).toContain(
        "Downloading files from GitHub"
      );
      expect(
        await page.getByRole("button", { exact: true, name: "Cancel" }).count()
      ).toBe(1);
      held.resolve();
      await expect
        .poll(() => resultPanel(page).isVisible(), { timeout: 60_000 })
        .toBe(true);
      expect(await resultPanel(page).textContent()).toContain("octo/demo");
      // The refusal described a URL the page dropped; it goes with the result.
      expect(await alert(page).count()).toBe(0);
      await page.getByRole("button", { name: "New scan" }).click();
      expect(await alert(page).count()).toBe(0);
    });
  }

  it("a second scan replaces a running one, which never shows or publishes", async () => {
    const { github, page } = await open();
    const held = deferred<void>();
    github.hook(async (url) => {
      if (
        url.host === "raw.githubusercontent.com" &&
        url.pathname.startsWith("/octo/demo/")
      ) {
        await held.promise;
      }
    });
    await scan(page, { repo: "https://github.com/octo/demo" });
    await expect
      .poll(() => page.getByRole("status").textContent(), { timeout: 60_000 })
      .toContain("Downloading files from GitHub");
    await scan(page, { repo: "https://github.com/octo/other" });
    await expect
      .poll(() => resultPanel(page).isVisible(), { timeout: 60_000 })
      .toBe(true);
    held.resolve();
    await page.waitForTimeout(1500);
    expect(await resultPanel(page).textContent()).toContain("octo/other");
    expect(await resultPanel(page).textContent()).not.toContain("octo/demo");
  });

  it("starts over, and a reload prefills the form without scanning", async () => {
    const { page, requests } = await open();
    await scan(page, { ref: "nope", repo: "https://github.com/octo/demo" });
    await expect
      .poll(() => alert(page).isVisible(), { timeout: 60_000 })
      .toBe(true);
    expect(new URL(page.url()).searchParams.get("ref")).toBe("nope");
    await page.reload();
    expect(await page.getByLabel("Public GitHub repository").inputValue()).toBe(
      "https://github.com/octo/demo"
    );
    expect(
      await page.getByLabel("Branch, tag or commit (optional)").inputValue()
    ).toBe("nope");
    const before = githubRequests(requests).length;
    await page.waitForTimeout(500);
    expect(githubRequests(requests).length).toBe(before);
    await page.getByRole("button", { exact: true, name: "Scan" }).click();
    await expect
      .poll(() => alert(page).isVisible(), { timeout: 60_000 })
      .toBe(true);
    await page.getByRole("button", { name: "Start over" }).click();
    expect(await page.getByLabel("Public GitHub repository").inputValue()).toBe(
      ""
    );
    expect(new URL(page.url()).search).toBe("");
    expect(await alert(page).count()).toBe(0);
  });

  it("keeps the map when a new scan is begun and then abandoned", async () => {
    const { page } = await open();
    await scan(page, { repo: "https://github.com/octo/demo" });
    await expect
      .poll(() => resultPanel(page).isVisible(), { timeout: 60_000 })
      .toBe(true);
    await page.getByRole("button", { name: "New scan" }).click();
    await page.getByRole("button", { name: "Keep this map" }).click();
    expect(await resultPanel(page).textContent()).toContain("octo/demo");
    // A mistyped URL is refused in the form; the map stays.
    await page.getByRole("button", { name: "New scan" }).click();
    await scan(page, { repo: "https://github.com/octo" });
    await expect
      .poll(() => alert(page).textContent())
      .toContain("That repository URL is not supported");
    expect(await page.locator("canvas").count()).toBeGreaterThan(0);
    // A second scan from the map replaces it with the new result.
    await scan(page, { ref: "main", repo: "https://github.com/octo/other" });
    await expect
      .poll(() => resultPanel(page).textContent(), { timeout: 60_000 })
      .toContain("octo/other");
  });

  it.runIf(SERVES_WEBSITE)(
    "foundry.sh keeps the scan unlisted, but its direct route remains available",
    async () => {
      const { page, requests } = await open();
      await page.goto(`${site.origin}/`);
      expect(await page.locator(`a[href="${SCAN_PATH}"]`).count()).toBe(0);
      const sitemap = await page.request.get(`${site.origin}/sitemap.xml`);
      expect(await sitemap.text()).not.toContain(SCAN_PATH);
      expect(requests.some((url) => url.includes("/analysis/"))).toBe(false);
      expect(githubRequests(requests)).toEqual([]);
      await page.goto(`${site.origin}${SCAN_PATH}`);
      expect(
        await page.locator('meta[name="robots"]').getAttribute("content")
      ).toBe("noindex");
      expect(await page.title()).toBe("Spyglass: scan a repository");
      await page.getByLabel("Public GitHub repository").waitFor();
      // The page's own files only, all under the route; no engine yet.
      const own = requests.filter(
        (url) =>
          new URL(url).origin === site.origin &&
          new URL(url).pathname.startsWith(SCAN_PATH)
      );
      expect(own.length).toBeGreaterThan(0);
      expect(requests.some((url) => url.includes("/analysis/"))).toBe(false);
      expect(githubRequests(requests)).toEqual([]);
    }
  );
});
