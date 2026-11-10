import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { DEVANAGARI_SUBSET as plan } from "~/generation/script-extension/devanagari-subset";
import {
  type WrittenExtension,
  writeExtension,
} from "../../../scripts/generation/extend-script";
import { SUBSET_RUN_DIR } from "./helpers/subset";

const FONTS = path.join(import.meta.dirname, "../../fixtures/fonts");

/** Starting the font engine and building a font can outlast the default hook limit. */
const SETUP_TIMEOUT = 120_000;

describe("the extend-script command", () => {
  const outputDirectory = mkdtempSync(path.join(tmpdir(), "extend-script-"));
  let written: WrittenExtension;

  beforeAll(async () => {
    written = await writeExtension({
      outputDirectory,
      plan,
      referenceFont: path.join(FONTS, "NotoSansDevanagari-wdth-wght.ttf"),
      runDirectory: SUBSET_RUN_DIR,
      sourceFont: path.join(FONTS, "Lato-Regular.ttf"),
    });
  }, SETUP_TIMEOUT);

  afterAll(() => {
    rmSync(outputDirectory, { force: true, recursive: true });
  });

  it("writes a derived font that is renamed and shapes the first test word", () => {
    const derived = harfBuzzReader.open(
      new Uint8Array(readFileSync(written.files.font))
    );
    // Lato reserves its name, so the font written to disk does not carry it.
    expect(derived.description.familyName).toBe("Devanagari Subset");
    expect(written.files.font).not.toContain("Lato");
    expect(derived.shape("नमस्ते", { script: "Deva" }).glyphs).toHaveLength(5);
    derived.close();
  });

  it("writes a verification report that states its scope", () => {
    const report = readFileSync(written.files.report, "utf8");
    expect(written.report.pass).toBe(true);
    expect(report).toContain(
      "# Verification: a Devanagari subset, built as Devanagari Subset"
    );
    expect(report).toContain("Letter identity against Noto Sans Devanagari");
    expect(report).toContain("## Not verified");
  });

  it("writes a proof sheet that sets every test word in outlines", () => {
    const sheet = readFileSync(written.files.proofSheet, "utf8");
    expect(sheet.startsWith("<svg")).toBe(true);
    expect(sheet).toContain("replayed without calling a model");
    for (const word of plan.words) {
      expect(sheet).toContain(word.glyphs.join(" "));
    }
    // One path for each glyph of the nine words, the Latin sample and the two words beside it.
    const glyphs = plan.words.reduce(
      (sum, word) => sum + word.glyphs.length,
      0
    );
    expect(sheet.match(/<path /g)?.length).toBe(glyphs + "Hamburg".length + 10);
    expect(sheet).not.toContain("NaN");
  });
});
