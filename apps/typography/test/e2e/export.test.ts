/**
 * The third milestone, proved in real Chrome: plan a Basic Latin subset of
 * Lato under a new family name, see the licence block the plan until the name
 * no longer contains the reserved one, build, read the validation report,
 * download the file, and then check the downloaded bytes in this process and
 * with the independent validator. The Proof place is walked afterwards.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Locator, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import {
  VALIDATOR_PROGRAM,
  validatorArguments,
  validatorCommand,
} from "~/proof/validator-command";
import { charactersIn } from "~/unicode/scope";
import { type AppSession, FIXTURE_FONTS, startApp } from "./support/app";

const PORT = 5333;
const APP_ROOT = path.join(import.meta.dirname, "../..");
const LATO = "Lato-Regular.ttf";
const SUBSET_FILE = "AtlasSans-Regular-subset.ttf";
const PACKED_FILE = "AtlasSans-Regular-subset.woff2";
const BUILD_TIMEOUT = 150_000;

const BUILD = /^Build \d+ fonts?$/;
const BASIC_LATIN = /^Basic Latin,/;
const RESERVED_NAME = /reserves the name "Lato"/;
const ENGINE_FAILURE = /The font engine (stopped|did not start).* Try again\./;
const WORKING_FACE = /Lato Regular, working face/;

const uvIsInstalled = spawnSync(VALIDATOR_PROGRAM, ["--version"]).status === 0;

interface IndependentReport {
  readonly accepted: boolean;
  readonly characters?: { readonly missing: readonly string[] };
  readonly fontTools: { readonly familyName?: string };
  readonly shaping?: { readonly glyphs?: readonly unknown[] };
}

const section = (page: Page, name: string) =>
  page.getByRole("region", { exact: true, name });

/** The result column of a table, row by row, as written: the tags print in capitals. */
const resultsOf = (table: Locator) =>
  table
    .locator("tbody tr .ty-outcome")
    .evaluateAll((tags) => tags.map((tag) => tag.textContent?.trim() ?? ""));

describe("export and proof, in Chrome", () => {
  let app: AppSession;
  let page: Page;
  let downloads: string;
  let subset: Uint8Array;

  /** Clicks a download button and reads the file the browser saved. */
  const download = async (button: Locator) => {
    const [saved] = await Promise.all([
      page.waitForEvent("download"),
      button.click(),
    ]);
    const file = path.join(downloads, saved.suggestedFilename());
    await saved.saveAs(file);
    return { bytes: new Uint8Array(await readFile(file)), file };
  };

  const build = async (fileName: string) => {
    await section(page, "Plan").getByRole("button", { name: BUILD }).click();
    const built = page
      .getByTestId("built-font")
      .filter({ has: page.getByRole("heading", { name: fileName }) });
    await built.waitFor({ timeout: BUILD_TIMEOUT });
    return built;
  };

  beforeAll(async () => {
    downloads = await mkdtemp(path.join(tmpdir(), "typography-export-"));
    app = await startApp({ port: PORT });
    ({ page } = app);
  });

  afterAll(async () => {
    await app.close();
    await rm(downloads, { force: true, recursive: true });
  });

  it("says what goes here while the project is empty", async () => {
    await app.goto("/export");
    await expect
      .poll(() => page.locator("main").innerText())
      .toContain("Nothing to export yet");
    await app.goto("/proof");
    await expect
      .poll(() => page.locator("main").innerText())
      .toContain("Nothing to prove yet");
  });

  it("plans a Basic Latin subset and blocks it while the name contains Lato", async () => {
    await app.goto("/import");
    await page
      .getByLabel("Add font files")
      .setInputFiles(path.join(FIXTURE_FONTS, LATO));
    await page
      .getByRole("table", { name: "Imported source fonts" })
      .getByText(LATO)
      .first()
      .waitFor();

    await app.goto("/export");
    const faces = section(page, "Faces");
    await faces.waitFor();
    expect(
      await faces.getByRole("checkbox", { name: "Lato Regular" }).isChecked()
    ).toBe(true);

    // Untouched, the plan changes nothing, so there is nothing to build.
    const plan = section(page, "Plan");
    const buildButton = plan.getByRole("button", { name: BUILD });
    await expect.poll(() => plan.innerText()).toContain("Nothing to build");
    expect(await buildButton.isDisabled()).toBe(true);

    const characters = section(page, "Characters");
    await characters.getByRole("radio", { name: "A selection" }).check();
    await characters.getByRole("checkbox", { name: BASIC_LATIN }).check();
    await expect
      .poll(() => characters.getByRole("table").innerText())
      .toContain("96 of");

    // With its own name kept, and with a name that still contains Lato.
    const problems = plan.getByTestId("plan-problems");
    await expect.poll(() => problems.innerText()).toMatch(RESERVED_NAME);
    const name = page.getByLabel("Family name");
    await name.fill("Lato Subset");
    await expect.poll(() => problems.innerText()).toMatch(RESERVED_NAME);
    expect(await buildButton.isDisabled()).toBe(true);
    await app.screenshot("export-e2e-blocked");

    await name.fill("Atlas Sans");
    await expect.poll(() => problems.innerText()).toBe("");
    await expect.poll(() => plan.innerText()).toContain(SUBSET_FILE);
    expect(await buildButton.isEnabled()).toBe(true);
    expect(app.errors).toEqual([]);
  });

  it("builds the subset, passes every validation check, and downloads it", async () => {
    const built = await build(SUBSET_FILE);
    // Six checks, each one run and passed: a check that did not run is not a pass.
    expect(await resultsOf(built.getByRole("table"))).toEqual([
      "Pass",
      "Pass",
      "Pass",
      "Pass",
      "Pass",
      "Pass",
    ]);
    expect(await built.innerText()).toContain("6 of 6 checks passed");
    await page.setViewportSize({ height: 3400, width: 1440 });
    await app.screenshot("export-e2e-built");
    await page.setViewportSize({ height: 900, width: 1440 });

    const saved = await download(
      built.getByRole("button", { name: `Download ${SUBSET_FILE}` })
    );
    expect(path.basename(saved.file)).toBe(SUBSET_FILE);
    subset = saved.bytes;
    expect(app.errors).toEqual([]);
  });

  it("gives a file that holds exactly the selection and still forms fi", async () => {
    const source = harfBuzzReader.open(
      new Uint8Array(await readFile(path.join(FIXTURE_FONTS, LATO)))
    );
    const selected = new Set(
      charactersIn({ kind: "block", name: "Basic Latin" })
    );
    const expected = [...source.characters()].filter((character) =>
      selected.has(character)
    );
    const derived = harfBuzzReader.open(subset);
    try {
      // The 95 printing characters of ASCII, and one control the font also maps.
      expect(expected).toHaveLength(96);
      expect([...derived.characters()]).toEqual(expected);
      expect(derived.description.familyName).toBe("Atlas Sans");
      expect(derived.shape("fi").glyphs).toHaveLength(1);
      // The source does the same, so the ligature was kept, not invented.
      expect(source.shape("fi").glyphs).toHaveLength(1);
    } finally {
      derived.close();
      source.close();
    }

    if (!uvIsInstalled) {
      console.warn(
        "Skipped the independent validator: uv is not on PATH. Install uv (https://docs.astral.sh/uv) to run it."
      );
      return;
    }
    const result = spawnSync(
      VALIDATOR_PROGRAM,
      validatorArguments({
        characters: expected,
        fontPath: path.join(downloads, SUBSET_FILE),
        shape: "office",
      }),
      { cwd: APP_ROOT, encoding: "utf8" }
    );
    const report = JSON.parse(result.stdout) as IndependentReport;
    expect(report.characters?.missing).toEqual([]);
    expect(report.fontTools.familyName).toBe("Atlas Sans");
    // Native HarfBuzz joins f, f and i too: six characters, four glyphs.
    expect(report.shaping?.glyphs).toHaveLength(4);
    expect(report.accepted).toBe(true);
    expect(result.status).toBe(0);
  });

  it("keeps downloading the original a separate action that returns the imported bytes", async () => {
    const originals = section(page, "Original files");
    const saved = await download(
      originals.getByRole("button", { name: "Download original" })
    );
    expect(path.basename(saved.file)).toBe(LATO);
    const fixture = await readFile(path.join(FIXTURE_FONTS, LATO));
    expect(Buffer.from(saved.bytes).equals(fixture)).toBe(true);
  });

  it("proves the built font against its source", async () => {
    await page
      .getByTestId("built-font")
      .getByRole("link", { name: "Prove this font" })
      .click();
    const shaping = section(page, "Shaping tests");
    await shaping.waitFor({ timeout: BUILD_TIMEOUT });
    expect(await page.getByTestId("proof-facts").innerText()).toContain(
      "Atlas Sans Regular"
    );
    const shapingResults = await resultsOf(shaping.getByRole("table"));
    expect(shapingResults.length).toBeGreaterThanOrEqual(5);
    expect(new Set(shapingResults)).toEqual(new Set(["Pass"]));

    // No glyph was changed, so no pixel of any sample may differ.
    const pixels = section(page, "Pixel comparison");
    const pixelResults = await resultsOf(pixels.getByRole("table"));
    expect(pixelResults).toHaveLength(shapingResults.length);
    expect(new Set(pixelResults)).toEqual(new Set(["Pass"]));
    expect(await pixels.locator(".ty-proof-picture").count()).toBe(0);
    expect(await section(page, "Changed glyphs").innerText()).toContain(
      "changed no glyph"
    );

    // The text is set in the derived font's own bytes.
    const derivedFamily = await section(page, "In text")
      .locator("figure")
      .nth(1)
      .locator(".ty-proof-text")
      .evaluate((element) => getComputedStyle(element).fontFamily);
    expect(derivedFamily).toContain("Typography Proof");
    expect(
      await page.evaluate(
        (family) => document.fonts.check(`20px ${family}`),
        derivedFamily
      )
    ).toBe(true);

    // The command on screen is the one this test ran, for the usual download place.
    const source = harfBuzzReader.open(subset);
    const kept = [...source.characters()];
    source.close();
    expect(
      (await page.getByTestId("validator-command").innerText()).trim()
    ).toBe(
      validatorCommand({
        characters: kept,
        fontPath: `~/Downloads/${SUBSET_FILE}`,
        shape: "office",
      })
    );
    await page.setViewportSize({ height: 3000, width: 1440 });
    await app.screenshot("proof-e2e-built");
    await page.setViewportSize({ height: 900, width: 1440 });
    expect(app.errors).toEqual([]);
  });

  it("builds the working face on demand and proves it", async () => {
    await page
      .getByRole("combobox", { name: "Font to prove" })
      .selectOption({ label: "Lato Regular, the working face" });
    await page.getByRole("button", { name: "Build and prove" }).click();
    const shaping = section(page, "Shaping tests");
    await shaping.waitFor({ timeout: BUILD_TIMEOUT });
    expect(await page.getByTestId("proof-facts").innerText()).toMatch(
      WORKING_FACE
    );
    expect(new Set(await resultsOf(shaping.getByRole("table")))).toEqual(
      new Set(["Pass"])
    );
    expect(
      new Set(
        await resultsOf(section(page, "Pixel comparison").getByRole("table"))
      )
    ).toEqual(new Set(["Pass"]));
    // A working face build is a proof, not an export, so no command is offered for it.
    expect(await page.getByTestId("validator-command").count()).toBe(0);
    expect(app.errors).toEqual([]);
  });

  it("builds the same plan as WOFF2, which the browser and the engine both accept", async () => {
    await app.goto("/export");
    // The plan is still as it was left.
    expect(await page.getByLabel("Family name").inputValue()).toBe(
      "Atlas Sans"
    );
    await section(page, "Format and name")
      .getByRole("radio", { name: "WOFF2 (.woff2)" })
      .check();
    await expect
      .poll(() => section(page, "Built fonts").innerText())
      .toContain("has changed since these fonts were built");
    const built = await build(PACKED_FILE);
    expect(new Set(await resultsOf(built.getByRole("table")))).toEqual(
      new Set(["Pass"])
    );
    expect(await built.innerText()).toContain("reopens after unpacking");
    expect(app.errors).toEqual([]);
  });

  it("fits a phone", async () => {
    await page.setViewportSize({ height: 2600, width: 390 });
    await app.screenshot("export-e2e-390");
    expect(
      await page.evaluate(() => {
        const main = document.querySelector("main");
        return main ? main.scrollWidth <= main.clientWidth : false;
      })
    ).toBe(true);
    await page
      .getByTestId("built-font")
      .getByRole("link", { name: "Prove this font" })
      .click();
    await section(page, "Shaping tests").waitFor({ timeout: BUILD_TIMEOUT });
    await app.screenshot("proof-e2e-390");
    await page.setViewportSize({ height: 900, width: 1440 });
  });
});

describe("an engine that cannot start, in Chrome", () => {
  let app: AppSession;
  let page: Page;

  beforeAll(async () => {
    app = await startApp({ port: PORT });
    ({ page } = app);
  });

  afterAll(async () => {
    await app.close();
  });

  it("shows the failure with the engine's message, and builds once the engine can start", async () => {
    // The engine's runtime is served from /engine/. Without it the engine cannot start.
    await page.route("**/engine/**", (route) => route.abort());
    await app.goto("/import");
    await page
      .getByLabel("Add font files")
      .setInputFiles(path.join(FIXTURE_FONTS, LATO));
    await page.getByText("1 font imported.").waitFor();
    await app.goto("/export");
    const characters = section(page, "Characters");
    await characters.getByRole("radio", { name: "A selection" }).check();
    await characters.getByRole("checkbox", { name: BASIC_LATIN }).check();
    await page.getByLabel("Family name").fill("Atlas Sans");
    await section(page, "Plan").getByRole("button", { name: BUILD }).click();

    const failure = section(page, "Built fonts").getByRole("alert");
    await failure.waitFor({ timeout: BUILD_TIMEOUT });
    const said = await failure.innerText();
    expect(said).toContain(`${SUBSET_FILE} was not built.`);
    // The message is the engine client's own: what went wrong and the way out.
    expect(said).toMatch(ENGINE_FAILURE);
    expect(await page.getByTestId("built-font").count()).toBe(0);
    expect(
      (await page.locator(".ty-masthead-status").innerText()).toLowerCase()
    ).toContain("font engine did not start");
    await app.screenshot("export-e2e-engine-failed");

    await page.unroute("**/engine/**");
    await failure.getByRole("button", { name: "Build again" }).click();
    const built = page.getByTestId("built-font");
    await built.waitFor({ timeout: BUILD_TIMEOUT });
    expect(await built.innerText()).toContain("6 of 6 checks passed");
  });
});
