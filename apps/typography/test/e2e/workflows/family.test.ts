/**
 * Select a family, generate coordinated variants, export: Sofia Sans gains letters at three weights.
 *
 * One of the workflows of the eighth milestone, proved in real Chrome: driven
 * through the interface from an empty project, moving from place to place by
 * the links the places offer. Nothing here calls a model. Generated glyphs
 * come from recorded runs, which are saved model output replayed, or from
 * the procedural strategy, which builds by rule.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { measureInk } from "~/generation/style/measure";
import type { OpenFace } from "~/typeface/reading";
import { PORTS } from "../support/ports";
import { BUILD_TIMEOUT, section } from "../support/screen";
import {
  BUILD,
  codeOf,
  fixtureFont,
  LINKS_A_WORKFLOW_MEETS,
  SOFIA,
  startWorkflows,
  WORKFLOW_TIMEOUT,
  withFaces,
} from "../support/workflow";

/** Three masters of Sofia Sans take about eleven seconds in Chrome. */
const VARIABLE_BUILD_TIMEOUT = 240_000;

describe("four workflows from an empty project to a downloaded font, in Chrome", () => {
  const {
    collectLinks,
    deadLinks,
    download,
    hash,
    linksMet,
    loadSample,
    on,
    shoot,
    shootNarrow,
    startEmpty,
    statusLine,
    validate,
  } = startWorkflows(PORTS.workflowFamily);

  it(
    "select a family, generate coordinated variants, export: Sofia Sans gains letters at three weights and leaves as three static fonts and as one variable font",
    async () => {
      const { app, page } = on();
      const family = "Sofia Extended";
      /** The axis minimum, default and maximum: the three weights the place starts with. */
      const weights = [1, 400, 1000];
      const styles = ["wght1", "Regular", "wght1000"];
      const staticFiles = styles.map((style) => `SofiaExtended-${style}.ttf`);
      const variableFile = "SofiaExtended-VariableRebuilt.ttf";
      const added = ["ĉ", "ĝ", "ũ", "Ĥ"];
      /** A weight between two masters, where nothing was drawn. */
      const between = 700;
      await startEmpty();
      await loadSample(SOFIA);

      // The Library leads a variable face straight to Generate across weights.
      await page.getByRole("link", { name: "Open the library" }).click();
      await section(page, "Face").waitFor();
      await shoot("4-00-library-variable-face", section(page, "Face"), 900);
      await shootNarrow("4-00-library-variable-face", section(page, "Face"));
      await page.getByRole("link", { name: "Generate across weights" }).click();
      await section(page, "Generate across weights").waitFor();
      const variableId = hash().split("/")[2] ?? "";
      expect(variableId).not.toContain("@");
      await expect
        .poll(() => page.getByTestId("family-weights").innerText())
        .toContain(
          "3 weights, lightest first: wght1 (1), Regular (400), wght1000 (1000)"
        );
      await page
        .getByRole("textbox", { name: "Characters" })
        .fill(added.join(" "));
      await shoot("4-01-across-weights", undefined, 2200);

      // The same characters on each weight, by rule. Each weight becomes a pinned instance.
      await page
        .getByRole("button", {
          name: `Generate ${added.length} glyphs at 3 weights`,
        })
        .click();
      const rows = page.locator("li.ty-family-character");
      await expect.poll(() => rows.count()).toBe(added.length);
      const board = section(page, "Candidates across weights");
      expect(await board.innerText()).toContain(
        "Built by rule on this machine. No model was called."
      );
      await expect
        .poll(statusLine)
        .toContain("1 font, 0 revisions, 12 candidates waiting");
      await board
        .getByRole("button", {
          name: `Accept everything that is compatible (${added.length} characters)`,
        })
        .click();
      await expect
        .poll(statusLine)
        .toContain("1 font, 12 revisions, font engine");
      // Every accepted cell leads to its glyph on its own pinned instance.
      const studioLinks = await board
        .locator('li.ty-family-cell[data-status="accepted"] a')
        .evaluateAll((anchors) =>
          anchors.map((anchor) =>
            decodeURIComponent(anchor.getAttribute("href") ?? "")
          )
        );
      expect(studioLinks).toHaveLength(added.length * weights.length);
      // Each names its character and weight for a reader who cannot see the cell.
      expect(
        await board
          .locator('li.ty-family-cell[data-status="accepted"] a')
          .first()
          .textContent()
      ).toBe("Open in the Studio, ĉ at wght1");
      for (const weight of weights) {
        expect(
          studioLinks.filter((href) =>
            href.startsWith(`#/studio/${variableId}@wght=${weight}/`)
          )
        ).toHaveLength(added.length);
      }
      await shoot("4-02-accepted-at-three-weights", board, 3200);

      // Export opens with the three pinned instances chosen, and not the variable face.
      const next = section(page, "Next");
      await shootNarrow("4-02-next", next);
      await next
        .getByRole("link", { name: "Plan an export of the pinned instances" })
        .click();
      const faces = section(page, "Faces");
      await faces.waitFor();
      expect(hash()).toBe(`#/export/instances/${variableId}`);
      const row = (note: string) =>
        faces.locator("li").filter({ hasText: note }).getByRole("checkbox");
      expect(await row("Variable, 1 axis").isChecked()).toBe(false);
      for (const weight of weights) {
        expect(await row(`Pinned at wght ${weight}.`).isChecked()).toBe(true);
      }
      await page.getByLabel("Family name").fill(family);

      // Three static fonts.
      const planSection = section(page, "Plan");
      for (const file of staticFiles) {
        await expect.poll(() => planSection.innerText()).toContain(file);
      }
      await planSection.getByRole("button", { name: BUILD }).click();
      const built = page.getByTestId("built-font");
      await expect
        .poll(() => built.count(), { timeout: BUILD_TIMEOUT })
        .toBe(staticFiles.length);
      const outcomes = await section(page, "Built fonts")
        .locator("tbody tr .ty-outcome")
        .evaluateAll((tags) =>
          tags.map((tag) => tag.textContent?.trim() ?? "")
        );
      expect(outcomes).not.toContain("Fail");
      await shoot(
        "4-03-three-static-fonts",
        section(page, "Built fonts"),
        3600
      );
      const statics: { bytes: Uint8Array; file: string }[] = [];
      for (const file of staticFiles) {
        statics.push(
          await download(page.getByRole("button", { name: `Download ${file}` }))
        );
      }

      // One variable font, rebuilt from the same three instances as masters.
      const variableFont = section(page, "Variable font");
      await variableFont
        .getByRole("radio", { name: "One variable font" })
        .check({ force: true });
      await expect
        .poll(() => variableFont.getByTestId("variable-file").innerText())
        .toBe(variableFile);
      await variableFont
        .getByRole("button", { name: "Build the variable font" })
        .click();
      const rebuilt = variableFont.getByTestId("built-variable-font");
      await rebuilt.waitFor({ timeout: VARIABLE_BUILD_TIMEOUT });
      expect(await rebuilt.innerText()).toContain(
        "2 of 2 checks that ran passed"
      );
      await shoot("4-04-one-variable-font", rebuilt, 1800);
      await shootNarrow("4-04-one-variable-font", rebuilt);
      const variable = await download(
        rebuilt.getByRole("button", { name: `Download ${variableFile}` })
      );
      expect(path.basename(variable.file)).toBe(variableFile);

      const source = await fixtureFont(SOFIA);
      const masters = statics.map(({ bytes }) => harfBuzzReader.open(bytes));
      const face = harfBuzzReader.open(variable.bytes);
      const inkOf = (font: OpenFace, letter: string, weight?: number) => {
        const glyph = font.glyphForCharacter(codeOf(letter));
        if (glyph === undefined) {
          throw new Error(`The font does not map ${letter}.`);
        }
        const { outline } = font.glyph(
          glyph,
          weight === undefined ? undefined : { wght: weight }
        );
        return (
          measureInk(outline, font.description.metrics.unitsPerEm)?.area ?? 0
        );
      };
      await withFaces([source, face, ...masters], () => {
        for (const [index, master] of masters.entries()) {
          expect(master.description.axes).toEqual([]);
          expect(master.description.familyName).toBe(family);
          expect(master.description.weightClass).toBe(weights[index]);
        }
        expect(face.description.familyName).toBe(family);
        expect(face.description.axes).toEqual([
          { default: 400, max: 1000, min: 1, name: "Weight", tag: "wght" },
        ]);
        for (const letter of added) {
          expect(source.glyphForCharacter(codeOf(letter))).toBeUndefined();
          // The same letter on each static font, heavier at each weight.
          const fixed = masters.map((master) => inkOf(master, letter));
          expect(fixed[0]).toBeGreaterThan(0);
          expect(fixed).toEqual(fixed.toSorted((a, b) => a - b));
          expect(new Set(fixed).size).toBe(fixed.length);
          // In the variable font it gets heavier all along the axis, between masters too.
          const along = [weights[0], weights[1], between, weights[2]].map(
            (weight) => inkOf(face, letter, weight)
          );
          expect(along).toEqual(along.toSorted((a, b) => a - b));
          expect(new Set(along).size).toBe(along.length);
        }
      });
      for (const { file } of [...statics, variable]) {
        const report = validate(file, {
          characters: added.map(codeOf),
          shape: added.join(""),
        });
        expect(report?.fontTools.familyName ?? family).toBe(family);
      }
      expect(app.errors).toEqual([]);
      // Every link met on the way names a place that exists.
      await collectLinks();
      expect(linksMet()).toBeGreaterThan(LINKS_A_WORKFLOW_MEETS);
      expect(deadLinks()).toEqual([]);
    },
    WORKFLOW_TIMEOUT
  );
});
