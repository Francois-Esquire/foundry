/**
 * What the workflow files share: one app in Chrome for the file, the steps
 * every workflow takes, and the checks every downloaded font goes through.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Locator, Page } from "playwright-core";
import { afterAll, beforeAll, expect } from "vitest";
import { parseHash } from "~/app/hash-location";
import { resolveRoute } from "~/app/places";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import {
  VALIDATOR_PROGRAM,
  validatorArguments,
} from "~/proof/validator-command";
import type { OpenFace } from "~/typeface/reading";
import { type AppSession, FIXTURE_FONTS, startApp } from "./app";
import { BUILD_TIMEOUT, NARROW, SETTLE_MS, section, WIDE } from "./screen";

const APP_ROOT = path.join(import.meta.dirname, "../../..");

/** One workflow: several builds, a download, and the validator's first run. */
export const WORKFLOW_TIMEOUT = 600_000;

export const BUILD = /^Build \d+ fonts?$/;

/**
 * How many different in-app links a workflow has to meet for its check that
 * none of them is dead to mean something. The four workflows once shared one
 * pool that had to hold more than 20. Each now has to hold more than 20 on its
 * own (they meet between 30 and 83), so a workflow that stopped looking at
 * links fails by itself.
 */
export const LINKS_A_WORKFLOW_MEETS = 20;

export const LATO = "Lato-Regular.ttf";
export const SOFIA = "SofiaSans-wght.ttf";

const uvIsInstalled = spawnSync(VALIDATOR_PROGRAM, ["--version"]).status === 0;

interface IndependentReport {
  readonly accepted: boolean;
  readonly characters?: { readonly missing: readonly string[] };
  readonly fontTools: { readonly familyName?: string };
}

export const codeOf = (letter: string) => letter.codePointAt(0) ?? 0;

export const fixtureFont = async (file: string) =>
  harfBuzzReader.open(
    new Uint8Array(await readFile(path.join(FIXTURE_FONTS, file)))
  );

/** Opens fonts for one check and closes them whatever the check finds. */
export const withFaces = async (
  faces: readonly OpenFace[],
  check: () => void | Promise<void>
) => {
  try {
    await check();
  } finally {
    for (const face of faces) {
      face.close();
    }
  }
};

/**
 * Starts the app for the workflows of one file, and stops it when they are
 * done. Call it inside the file's `describe`. `on()` answers with the app
 * and its page once the file's cases run.
 */
export const startWorkflows = (port: number) => {
  let app: AppSession;
  let page: Page;
  let places: Locator;
  let status: Locator;
  let downloads: string;
  /** Every in-app link seen on the way, to check that none leads nowhere. */
  const links = new Set<string>();

  const resize = async (size: { height: number; width: number }) => {
    await page.setViewportSize(size);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        })
    );
    await page.waitForTimeout(SETTLE_MS);
  };

  const collectLinks = async () => {
    const found = await page
      .locator('a[href^="#"]')
      .evaluateAll((anchors) =>
        anchors.map((anchor) => anchor.getAttribute("href") ?? "")
      );
    for (const href of found) {
      links.add(href);
    }
  };

  /**
   * A picture of one step at 1440 wide, from the top of the screen or of one
   * part of it, tall enough to show the step. Then back to the working size.
   */
  const shoot = async (name: string, from?: Locator, height = 1400) => {
    await collectLinks();
    await resize({ height, width: WIDE.width });
    await scrollTo(from);
    await app.screenshot(`workflow-${name}`);
    await resize(WIDE);
  };

  /** The end of a workflow at 390 wide, where nothing may be wider than the phone. */
  const shootNarrow = async (name: string, from?: Locator) => {
    await resize(NARROW);
    await scrollTo(from);
    await app.screenshot(`workflow-${name}-390`);
    expect(
      await page
        .locator("main")
        .evaluate((main) => main.scrollWidth - main.clientWidth)
    ).toBeLessThanOrEqual(1);
    await resize(WIDE);
  };

  const scrollTo = async (from?: Locator) => {
    if (from) {
      await from.evaluate((element) =>
        element.scrollIntoView({ block: "start" })
      );
    } else {
      await page.locator("main").evaluate((main) => main.scrollTo({ top: 0 }));
    }
    await page.waitForTimeout(SETTLE_MS);
  };

  /** Every workflow starts from an empty project on the first place. */
  const startEmpty = async () => {
    await resize(WIDE);
    await app.goto("/");
    await app.reload();
    await expect.poll(statusLine).toContain("no fonts yet");
  };

  const hash = () => decodeURIComponent(new URL(page.url()).hash);

  /** The masthead's line. The stylesheet prints it in capitals, so it is read without case. */
  const statusLine = async () => (await status.innerText()).toLowerCase();

  /** Loads one of the sample fonts the start offers. */
  const loadSample = async (file: string) => {
    await page.getByRole("button", { name: `Load ${file}` }).click();
    await page
      .getByRole("table", { name: "Imported source fonts" })
      .getByRole("cell", { exact: true, name: file })
      .waitFor();
  };

  const download = async (button: Locator) => {
    const [saved] = await Promise.all([
      page.waitForEvent("download"),
      button.click(),
    ]);
    const file = path.join(downloads, saved.suggestedFilename());
    await saved.saveAs(file);
    return { bytes: new Uint8Array(await readFile(file)), file };
  };

  /** Builds the plan on screen and waits for one of its fonts. */
  const buildPlan = async (fileName: string) => {
    const planSection = section(page, "Plan");
    await expect.poll(() => planSection.innerText()).toContain(fileName);
    await planSection.getByRole("button", { name: BUILD }).click();
    const built = page
      .getByTestId("built-font")
      .filter({ has: page.getByRole("heading", { name: fileName }) });
    await built.waitFor({ timeout: BUILD_TIMEOUT });
    return built;
  };

  /**
   * The independent validator on a downloaded file: native fontTools, the
   * OpenType Sanitizer and native HarfBuzz. Skipped, and said so, without uv.
   */
  const validate = (
    file: string,
    expected: { characters: readonly number[]; shape: string }
  ): IndependentReport | undefined => {
    if (!uvIsInstalled) {
      console.warn(
        `Skipped the independent validator on ${path.basename(file)}: uv is not on PATH.`
      );
      return;
    }
    const result = spawnSync(
      VALIDATOR_PROGRAM,
      validatorArguments({ ...expected, fontPath: file }),
      { cwd: APP_ROOT, encoding: "utf8" }
    );
    if (!result.stdout) {
      throw new Error(`The validator printed no report: ${result.stderr}`);
    }
    const report = JSON.parse(result.stdout) as IndependentReport;
    expect(report.characters?.missing).toEqual([]);
    expect(report.accepted).toBe(true);
    expect(result.status).toBe(0);
    return report;
  };

  beforeAll(async () => {
    downloads = await mkdtemp(path.join(tmpdir(), "typography-workflows-"));
    app = await startApp({ port, ...WIDE });
    ({ page } = app);
    places = page.getByRole("navigation", { name: "Places" });
    status = page.locator(".ty-masthead-status");
  });

  afterAll(async () => {
    await app.close();
    await rm(downloads, { force: true, recursive: true });
  });

  return {
    buildPlan,
    collectLinks,
    /** The links met so far that name no place. A workflow ends with none. */
    deadLinks: () =>
      [...links].filter(
        (href) => resolveRoute(parseHash(href)).kind !== "destination"
      ),
    download,
    hash,
    /** How many different links were met so far. */
    linksMet: () => links.size,
    loadSample,
    on: () => ({ app, page, places }),
    shoot,
    shootNarrow,
    startEmpty,
    statusLine,
    validate,
  };
};
