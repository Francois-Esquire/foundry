/**
 * The sixth milestone, proved in real Chrome: Sofia Sans, a variable font,
 * is loaded through the Import place and extended at three weights by the
 * procedural strategy. Every compatible character is accepted, and the three
 * pinned instances are then exported twice: as three static fonts, and as
 * one variable font rebuilt from them as masters. The downloaded files are
 * reopened in this process, and the variable font goes through the
 * independent validator when uv is installed.
 *
 * Nothing here calls a model. The new glyphs are built by rule.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Locator, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { measureInk } from "~/generation/style/measure";
import {
  VALIDATOR_PROGRAM,
  validatorArguments,
} from "~/proof/validator-command";
import { outlinePoints } from "~/typeface/outline";
import type { OpenFace } from "~/typeface/reading";
import { type AppSession, FIXTURE_FONTS, startApp } from "./support/app";
import { PORTS } from "./support/ports";
import { NARROW, SETTLE_MS, section, WIDE } from "./support/screen";

const APP_ROOT = path.join(import.meta.dirname, "../..");
const SOFIA = "SofiaSans-wght.ttf";
/** Accented letters Sofia Sans lacks and a rule can build from glyphs it has. */
const ADDED = ["ĉ", "ĝ", "ũ", "ǵ", "Ĥ", "ǐ"];
const FAMILY_NAME = "Sofia Extended";
/** The instance at each end of the axis has no name of its own, so it is called by its weight. */
const STYLES = ["wght1", "Regular", "wght1000"];
const STATIC_FILES = STYLES.map((style) => `SofiaExtended-${style}.ttf`);
const VARIABLE_FILE = "SofiaExtended-VariableRebuilt.ttf";
/** The axis minimum, default and maximum of Sofia Sans: the weights the place starts with. */
const WEIGHTS = [1, 400, 1000];
/** A weight between two masters, where nothing was drawn by hand or by rule. */
const BETWEEN = 700;
/** A build of three weights, which takes a little longer than one font's. */
const FAMILY_BUILD_TIMEOUT = 170_000;

const BUILD = /^Build \d+ fonts?$/;
const NO_REVISIONS = /1 font, 0 revisions/;
const THREE_REVISIONS = /1 font, 3 revisions/;
const ALL_REVISIONS = /1 font, 18 revisions/;
const STARTING_WEIGHTS =
  /3 weights, lightest first: wght1 \(1\), Regular \(400\), wght1000 \(1000\)/;
const EDITED_WEIGHTS =
  /3 weights, lightest first: Light \(300\), Regular \(400\), ExtraBold \(800\)/;
const NAME_KEPT = /keeps the family name Sofia Sans/;
const TOO_FEW = /A variable font needs at least two masters/;
const ONE_PINNED =
  /No variable font is offered for Sofia Sans\. Sofia Sans has one pinned instance, Regular\./;
const STRAIGHT_LINE = /interpolated in a straight line/;
const AXIS_MAPPING =
  /axis mapping and intermediate designs are not carried over/;
/** The progress label is printed in capitals by the stylesheet. */
const BUILDING =
  /(Starting the font engine|Building: SofiaExtended-VariableRebuilt\.ttf), \d+ s/i;

const uvIsInstalled = spawnSync(VALIDATOR_PROGRAM, ["--version"]).status === 0;

interface IndependentReport {
  readonly accepted: boolean;
  readonly characters?: { readonly missing: readonly string[] };
  readonly fontTools: { readonly familyName?: string };
}

const codeOf = (letter: string) => letter.codePointAt(0) ?? 0;

const keyOf = (letter: string) =>
  `u+${codeOf(letter).toString(16).padStart(4, "0")}`;

const glyphOf = (face: OpenFace, letter: string) => {
  const glyph = face.glyphForCharacter(codeOf(letter));
  if (glyph === undefined) {
    throw new Error(`The font does not map ${letter}.`);
  }
  return glyph;
};

/** How much ink a letter has, at a weight for a variable font. */
const inkOf = (face: OpenFace, letter: string, weight?: number) => {
  const location = weight === undefined ? undefined : { wght: weight };
  const { outline } = face.glyph(glyphOf(face, letter), location);
  return measureInk(outline, face.description.metrics.unitsPerEm)?.area ?? 0;
};

const importSofia = async (page: Page) => {
  await page
    .getByRole("navigation", { name: "Places" })
    .getByRole("link", { name: "Import" })
    .click();
  await page
    .getByLabel("Add font files")
    .setInputFiles(path.join(FIXTURE_FONTS, SOFIA));
  await page.getByRole("cell", { name: SOFIA }).first().waitFor();
};

describe("family-wide generation and a variable font, in Chrome", () => {
  let app: AppSession;
  let page: Page;
  let places: Locator;
  let downloads: string;
  let statics: Uint8Array[] = [];
  let variable: Uint8Array;

  /** Changes the viewport and waits for the page to be drawn at the new size. */
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

  /** A picture of the whole screen at 1440 wide, then back to the working size. */
  const shoot = async (name: string, height: number) => {
    await resize({ height, width: WIDE.width });
    await app.screenshot(name);
    await resize(WIDE);
  };

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

  const characters = () => page.locator("li.ty-family-character");

  const cellStatuses = (letter: string) =>
    page
      .locator(`li[data-character="${keyOf(letter)}"] li.ty-family-cell`)
      .evaluateAll((cells) =>
        cells.map((cell) => [
          cell.getAttribute("data-weight"),
          cell.getAttribute("data-status"),
        ])
      );

  const everyCell = (status: string) =>
    WEIGHTS.map((weight) => [String(weight), status]);

  beforeAll(async () => {
    downloads = await mkdtemp(path.join(tmpdir(), "typography-family-"));
    app = await startApp({ port: PORTS.family, ...WIDE });
    ({ page } = app);
    places = page.getByRole("navigation", { name: "Places" });
    await importSofia(page);
  });

  afterAll(async () => {
    await app.close();
    await rm(downloads, { force: true, recursive: true });
  });

  it("works across weights for a variable face instead of refusing it", async () => {
    await places.getByRole("link", { name: "Generate" }).click();
    await section(page, "Generate across weights").waitFor();
    const face = page.getByRole("combobox", { name: "Variable face" });
    await face.selectOption({
      label: "Sofia Sans Regular, variable: generates across weights",
    });

    // The axis minimum, default and maximum to start with.
    const weights = section(page, "Weights");
    const chosen = weights.getByTestId("family-weights");
    await expect.poll(() => chosen.innerText()).toMatch(STARTING_WEIGHTS);
    await app.screenshot("family-e2e-1-starting-weights");

    // Each is editable: two are moved to named instances, one of them typed.
    await weights
      .getByRole("list", { name: "Weight 1 stops" })
      .getByRole("button", { exact: true, name: "Light" })
      .click();
    const heaviest = weights.getByRole("textbox", { name: "Weight 3 value" });
    await heaviest.fill("800");
    await heaviest.press("Enter");
    await expect.poll(() => chosen.innerText()).toMatch(EDITED_WEIGHTS);

    // Two at least: a third weight can go, a second cannot.
    const removeFirst = weights.getByRole("button", {
      name: "Remove weight 1",
    });
    expect(await removeFirst.isEnabled()).toBe(true);
    await weights.getByRole("button", { name: "Add a weight" }).click();
    await expect
      .poll(() => weights.getByRole("slider").count())
      .toBe(WEIGHTS.length + 1);
    await weights.getByRole("button", { name: "Remove weight 4" }).click();
    await expect.poll(() => chosen.innerText()).toMatch(EDITED_WEIGHTS);

    // Back to the three it started with, which is what the run keeps.
    const lightest = weights.getByRole("textbox", { name: "Weight 1 value" });
    await lightest.fill("1");
    await lightest.press("Enter");
    await heaviest.fill("1000");
    await heaviest.press("Enter");
    await expect.poll(() => chosen.innerText()).toMatch(STARTING_WEIGHTS);

    await page
      .getByRole("textbox", { name: "Characters" })
      .fill(ADDED.join(" "));
    const targets = page.getByRole("table", {
      name: "Targets of this request and what each depends on",
    });
    await expect
      .poll(() => targets.locator("tbody tr").count())
      .toBe(ADDED.length);
    expect(await targets.innerText()).toContain("Missing from the face");
    expect(await targets.innerText()).not.toContain("Holdout test");
    expect(app.errors).toEqual([]);
  });

  it("estimates a model run as one call for each weight, and calls no model for a rule", async () => {
    const strategy = (name: string) =>
      page.locator(".ty-generate-strategy").filter({ hasText: name });
    const estimate = page.getByTestId("family-estimate");
    expect(
      await page
        .getByRole("radio", { exact: true, name: "Procedural" })
        .isChecked()
    ).toBe(true);
    expect(await estimate.innerText()).toContain(
      "runs on this machine and calls no model, so it costs nothing"
    );

    await strategy("Vector model").click();
    await expect
      .poll(() => estimate.locator("[data-calls]").getAttribute("data-calls"))
      .toBe(String(WEIGHTS.length));
    const said = await estimate.innerText();
    expect(said).toContain("3 calls to the model");
    expect(said).toContain(
      "Each call draws a sheet of up to 6 glyphs: 1 call for each of 3 faces is 3 calls."
    );
    expect(said).toContain("The provider's bill is the real figure.");
    const run = page.getByRole("button", {
      name: "Generate 6 glyphs at 3 weights",
    });
    expect(await run.isDisabled()).toBe(true);
    await app.screenshot("family-e2e-2-model-estimate");

    // A recorded run is one face at one weight, and says so.
    expect(await strategy("Recorded run").innerText()).toContain(
      "cannot be replayed across weights"
    );
    await strategy("Procedural").click();
    await expect.poll(() => run.isEnabled()).toBe(true);
  });

  it("generates at three weights, names each weight, and proposes compatible candidates", async () => {
    await page
      .getByRole("button", { name: "Generate 6 glyphs at 3 weights" })
      .click();
    await expect.poll(() => characters().count()).toBe(ADDED.length);

    const lines = await page
      .getByRole("list", { name: "Weights of the run" })
      .locator("li")
      .evaluateAll((rows) =>
        rows.map((row) => [
          row.getAttribute("data-weight"),
          row.getAttribute("data-weight-status"),
          row.textContent ?? "",
        ])
      );
    expect(lines.map(([weight, status]) => [weight, status])).toEqual(
      everyCell("generated")
    );
    expect(lines.map(([, , text]) => text)).toEqual(
      STYLES.map((style) => expect.stringContaining(style))
    );

    // Side by side from lightest to heaviest, each compatible, none accepted.
    for (const letter of ADDED) {
      const row = page.locator(`li[data-character="${keyOf(letter)}"]`);
      expect(await row.getAttribute("data-compatible")).toBe("true");
      expect(await row.innerText()).toContain(
        "can be masters of one variable glyph"
      );
      expect(await cellStatuses(letter)).toEqual(everyCell("proposed"));
    }
    const board = section(page, "Candidates across weights");
    expect(
      await board.locator("[data-run-source]").getAttribute("data-run-source")
    ).toBe("rule");
    expect(await board.innerText()).toContain(
      "Built by rule on this machine. No model was called."
    );
    expect(await board.innerText()).toContain(
      "6 of 6 could be masters of one variable glyph. 18 proposed, 0 accepted, 0 rejected."
    );
    expect(await page.getByText(NO_REVISIONS).count()).toBe(1);
    await shoot("family-e2e-3-candidates", 4400);
    expect(app.errors).toEqual([]);
  });

  it("accepts one character at every weight, then everything compatible, each as a revision", async () => {
    const first = page.locator(`li[data-character="${keyOf("ĉ")}"]`);
    await first
      .getByRole("button", { name: "Accept ĉ at every weight" })
      .click();
    await page.getByText(THREE_REVISIONS).waitFor();
    expect(await cellStatuses("ĉ")).toEqual(everyCell("accepted"));
    expect(await cellStatuses("ĝ")).toEqual(everyCell("proposed"));

    await page
      .getByRole("button", {
        name: "Accept everything that is compatible (5 characters)",
      })
      .click();
    await page.getByText(ALL_REVISIONS).waitFor();
    for (const letter of ADDED) {
      expect(await cellStatuses(letter)).toEqual(everyCell("accepted"));
    }
    // Each weight is now a pinned instance that can be chosen on its own.
    const options = await page
      .getByRole("combobox", { name: "Variable face" })
      .locator("option")
      .allInnerTexts();
    // Each says it is pinned and where, so the one that kept the style name
    // Regular does not read as the variable face.
    expect(options).toEqual([
      "Sofia Sans Regular, variable: generates across weights",
      "Sofia Sans, pinned at wght 1",
      "Sofia Sans Regular, pinned at wght 400",
      "Sofia Sans, pinned at wght 1000",
    ]);
    await first.scrollIntoViewIfNeeded();
    await app.screenshot("family-e2e-4-accepted");

    await resize(NARROW);
    await page.locator("main").evaluate((main) => main.scrollTo({ top: 0 }));
    await app.screenshot("family-e2e-5-narrow-request");
    await first.scrollIntoViewIfNeeded();
    await app.screenshot("family-e2e-5-narrow-candidates");
    expect(
      await page.evaluate(() => {
        const main = document.querySelector("main");
        return main ? main.scrollWidth <= main.clientWidth : false;
      })
    ).toBe(true);
    await resize(WIDE);
    expect(app.errors).toEqual([]);
  });

  it("offers one variable font beside the static fonts, and shows the plan with its warning", async () => {
    await places.getByRole("link", { name: "Export" }).click();
    const variableFont = section(page, "Variable font");
    await variableFont.waitFor();
    expect(
      await variableFont
        .getByRole("radio", { name: "Separate static fonts" })
        .isChecked()
    ).toBe(true);
    await variableFont
      .getByRole("radio", { name: "One variable font" })
      .check({ force: true });

    // The source's own name is kept until one is typed, and the plan says so.
    const warnings = variableFont.getByTestId("variable-warnings");
    await expect.poll(() => warnings.innerText()).toMatch(NAME_KEPT);
    expect(await variableFont.getByTestId("variable-file").innerText()).toBe(
      "SofiaSans-VariableRebuilt.ttf"
    );
    await page.getByLabel("Family name").fill(FAMILY_NAME);
    await expect.poll(() => warnings.innerText()).toBe("");
    await expect
      .poll(() => variableFont.getByTestId("variable-file").innerText())
      .toBe(VARIABLE_FILE);
    expect(await variableFont.innerText()).toMatch(STRAIGHT_LINE);

    // A problem blocks the build and says why: one master is not enough.
    const problems = variableFont.getByTestId("variable-problems");
    const build = variableFont.getByRole("button", {
      name: "Build the variable font",
    });
    const masters = variableFont.getByRole("list", {
      name: "Masters of Sofia Sans",
    });
    expect(await masters.getByRole("checkbox").count()).toBe(WEIGHTS.length);
    const master = (index: number) =>
      masters.getByRole("checkbox", {
        exact: true,
        name: `${STYLES[index]}, weight ${WEIGHTS[index]}`,
      });
    await master(0).uncheck({ force: true });
    await master(2).uncheck({ force: true });
    await expect.poll(() => problems.innerText()).toMatch(TOO_FEW);
    expect(await build.isDisabled()).toBe(true);
    await master(0).check({ force: true });
    await master(2).check({ force: true });
    await expect.poll(() => problems.innerText()).toBe("");
    expect(await build.isEnabled()).toBe(true);
    await variableFont.scrollIntoViewIfNeeded();
    await app.screenshot("family-e2e-6-variable-plan");
    expect(app.errors).toEqual([]);
  });

  it("exports the three instances as static fonts whose new letters get heavier", async () => {
    const faces = section(page, "Faces");
    const row = (note: string) =>
      faces.locator("li").filter({ hasText: note }).getByRole("checkbox");
    await row("Variable, 1 axis").uncheck({ force: true });
    for (const weight of WEIGHTS) {
      await row(`Pinned at wght ${weight}.`).check({ force: true });
    }
    const plan = section(page, "Plan");
    for (const file of STATIC_FILES) {
      await expect.poll(() => plan.innerText()).toContain(file);
    }
    await plan.getByRole("button", { name: BUILD }).click();
    const built = page.getByTestId("built-font");
    await expect
      .poll(() => built.count(), { timeout: FAMILY_BUILD_TIMEOUT })
      .toBe(STATIC_FILES.length);
    const results = await section(page, "Built fonts")
      .locator("tbody tr .ty-outcome")
      .evaluateAll((tags) => tags.map((tag) => tag.textContent?.trim() ?? ""));
    expect(results).not.toContain("Fail");
    console.info(`Static builds, validation results: ${results.join(" ")}`);
    await shoot("family-e2e-7-static-fonts", 4200);

    const saved: Uint8Array[] = [];
    for (const file of STATIC_FILES) {
      const { bytes } = await download(
        page.getByRole("button", { name: `Download ${file}` })
      );
      saved.push(bytes);
    }
    statics = saved;

    const opened = statics.map((bytes) => harfBuzzReader.open(bytes));
    try {
      for (const [index, face] of opened.entries()) {
        expect(face.description.axes).toEqual([]);
        expect(face.description.familyName).toBe(FAMILY_NAME);
        expect(face.description.weightClass).toBe(WEIGHTS[index]);
      }
      const source = harfBuzzReader.open(
        new Uint8Array(await readFile(path.join(FIXTURE_FONTS, SOFIA)))
      );
      for (const letter of ADDED) {
        expect(source.glyphForCharacter(codeOf(letter))).toBeUndefined();
        const [light, regular, heavy] = opened.map((face) =>
          inkOf(face, letter)
        );
        expect(light).toBeGreaterThan(0);
        expect(regular).toBeGreaterThan((light ?? 0) * 1.1);
        expect(heavy).toBeGreaterThan((regular ?? 0) * 1.3);
      }
      source.close();
    } finally {
      for (const face of opened) {
        face.close();
      }
    }
    expect(app.errors).toEqual([]);
  });

  it("builds one variable font, says what was checked and what was not, and downloads it", async () => {
    const variableFont = section(page, "Variable font");
    await variableFont
      .getByRole("button", { name: "Build the variable font" })
      .click();
    // The build takes a while, so the screen says what it is doing and counts.
    const progress = variableFont.getByTestId("variable-progress");
    await progress.waitFor();
    expect(await progress.innerText()).toMatch(BUILDING);
    expect(await progress.innerText()).toContain(
      "pins the source font at each of the 3 masters"
    );
    await progress.scrollIntoViewIfNeeded();
    await app.screenshot("family-e2e-8-variable-building");

    const built = variableFont.getByTestId("built-variable-font");
    await built.waitFor({ timeout: FAMILY_BUILD_TIMEOUT });
    expect(await progress.count()).toBe(0);

    // Two checks ran and passed. The rest of a static build's report did not run.
    const rows = await built
      .locator("tbody tr")
      .evaluateAll((trs) =>
        trs.map((tr) => [
          tr.querySelector("th")?.textContent?.trim() ?? "",
          tr.querySelector(".ty-outcome")?.textContent?.trim() ?? "",
        ])
      );
    expect(rows).toEqual([
      ["Font engine", "Pass"],
      ["Browser sanitizer", "Pass"],
      ["Reopening, characters, shaping, joining", "Not run"],
    ]);
    const said = await built.innerText();
    expect(said).toContain("2 of 2 checks that ran passed");
    expect(said).toContain("weight 1 to 1000");
    expect(said).not.toContain("6 of 6 checks passed");
    const notes = await built.getByTestId("variable-notes").innerText();
    expect(notes).toMatch(STRAIGHT_LINE);
    expect(notes).toMatch(AXIS_MAPPING);
    console.info(
      `Variable font build in Chrome: ${await built.getByTestId("variable-timings").innerText()}`
    );
    await built.scrollIntoViewIfNeeded();
    await shoot("family-e2e-9-variable-built", 2400);

    const saved = await download(
      built.getByRole("button", { name: `Download ${VARIABLE_FILE}` })
    );
    expect(path.basename(saved.file)).toBe(VARIABLE_FILE);
    variable = saved.bytes;
    expect(app.errors).toEqual([]);
  });

  it("gives a variable font with a weight axis in which the new letters interpolate", () => {
    const face = harfBuzzReader.open(variable);
    const [light, regular, heavy] = statics.map((bytes) =>
      harfBuzzReader.open(bytes)
    );
    try {
      expect(face.description.familyName).toBe(FAMILY_NAME);
      expect(face.description.axes).toEqual([
        { default: 400, max: 1000, min: 1, name: "Weight", tag: "wght" },
      ]);
      for (const letter of ADDED) {
        const glyph = glyphOf(face, letter);
        const outlines = [WEIGHTS[0], BETWEEN, WEIGHTS[2]].map((weight) =>
          JSON.stringify(face.glyph(glyph, { wght: weight ?? 0 }).outline)
        );
        expect(new Set(outlines).size).toBe(outlines.length);
        // Heavier all the way along the axis, a weight nobody drew included.
        const inks = [WEIGHTS[0], WEIGHTS[1], BETWEEN, WEIGHTS[2]].map(
          (weight) => inkOf(face, letter, weight)
        );
        expect(inks).toEqual(inks.toSorted((a, b) => a - b));
        expect(new Set(inks).size).toBe(inks.length);
        // At a master the variable font draws what the static font does,
        // to the whole font unit each of them rounds to.
        for (const [index, master] of [light, regular, heavy].entries()) {
          const drawn = outlinePoints(
            face.glyph(glyph, { wght: WEIGHTS[index] ?? 0 }).outline
          );
          const fixed = master
            ? outlinePoints(master.glyph(glyphOf(master, letter)).outline)
            : [];
          expect(drawn).toHaveLength(fixed.length);
          const furthest = Math.max(
            ...drawn.map((point, at) =>
              Math.max(
                Math.abs(point.x - (fixed[at]?.x ?? Number.NaN)),
                Math.abs(point.y - (fixed[at]?.y ?? Number.NaN))
              )
            )
          );
          expect(furthest).toBeLessThanOrEqual(1);
        }
      }
    } finally {
      for (const opened of [face, light, regular, heavy]) {
        opened?.close();
      }
    }
  });

  it("passes the independent validator when uv is installed", () => {
    if (!uvIsInstalled) {
      console.warn(
        "Skipped the independent validator: uv is not on PATH. Install uv (https://docs.astral.sh/uv) to run it."
      );
      return;
    }
    const result = spawnSync(
      VALIDATOR_PROGRAM,
      validatorArguments({
        characters: ADDED.map(codeOf),
        fontPath: path.join(downloads, VARIABLE_FILE),
        shape: ADDED.join(""),
      }),
      { cwd: APP_ROOT, encoding: "utf8" }
    );
    const report = JSON.parse(result.stdout) as IndependentReport;
    expect(report.characters?.missing).toEqual([]);
    expect(report.fontTools.familyName).toBe(FAMILY_NAME);
    expect(report.accepted).toBe(true);
    expect(result.status).toBe(0);
  });

  it("fits a phone", async () => {
    await resize(NARROW);
    const variableFont = section(page, "Variable font");
    await variableFont.scrollIntoViewIfNeeded();
    await app.screenshot("family-e2e-10-narrow-variable");
    expect(
      await page.evaluate(() => {
        const main = document.querySelector("main");
        return main ? main.scrollWidth <= main.clientWidth : false;
      })
    ).toBe(true);
    await resize(WIDE);
    expect(app.errors).toEqual([]);
  });
});

describe("a variable face with one pinned instance, in Chrome", () => {
  let app: AppSession;
  let page: Page;

  beforeAll(async () => {
    app = await startApp({ port: PORTS.family, ...WIDE });
    ({ page } = app);
    await importSofia(page);
  });

  afterAll(async () => {
    await app.close();
  });

  it("is not offered a variable font, and is told what is missing", async () => {
    const places = page.getByRole("navigation", { name: "Places" });
    await places.getByRole("link", { name: "Export" }).click();
    await section(page, "Faces").waitFor();
    // No pinned instance yet: nothing about a variable font at all.
    expect(await section(page, "Variable font").count()).toBe(0);

    await places.getByRole("link", { name: "Studio" }).click();
    await page.getByRole("button", { name: "Pin Regular" }).click();
    await places.getByRole("link", { name: "Export" }).click();
    const variableFont = section(page, "Variable font");
    await variableFont.waitFor();
    expect(await variableFont.innerText()).toMatch(ONE_PINNED);
    expect(
      await variableFont
        .getByRole("radio", { name: "One variable font" })
        .count()
    ).toBe(0);
    expect(
      await variableFont
        .getByRole("button", { name: "Build the variable font" })
        .count()
    ).toBe(0);
    await variableFont.scrollIntoViewIfNeeded();
    await app.screenshot("family-e2e-11-one-pinned");
    expect(app.errors).toEqual([]);
  });
});
