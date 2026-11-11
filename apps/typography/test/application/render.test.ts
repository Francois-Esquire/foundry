/** Text set in a font's own bytes, drawn as SVG paths. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Application } from "~/application/application";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { fixtureAt, tempProject } from "./helpers/project";

const DRAWN = /<path transform=/g;
const CROSSED = /<path fill="none"/g;

const count = (svg: string, pattern: RegExp) => svg.match(pattern)?.length ?? 0;

describe("rendering text in a font", () => {
  const { open, remove } = tempProject();
  let app: Application;
  let lato = "";
  let devanagari = "";
  let photograph = "";

  beforeAll(async () => {
    app = await open();
    const imported = await app.import([
      fixtureAt("fonts/Lato-Regular.ttf"),
      fixtureAt("fonts/NotoSansDevanagari-wdth-wght.ttf"),
      fixtureAt("evidence/storefront-needed-things.jpg"),
    ]);
    lato = imported.fonts[0]?.artifactId ?? "";
    devanagari = imported.fonts[1]?.artifactId ?? "";
    photograph = imported.photographs[0]?.artifactId ?? "";
  });

  afterAll(async () => {
    await app.close();
    remove();
  });

  it("draws one path for each glyph the font shapes the text to", async () => {
    const picture = await app.render({
      font: { artifactId: lato },
      text: "Hamburg",
    });
    expect(picture.svg.startsWith("<svg")).toBe(true);
    expect(picture.missing).toEqual([]);
    expect(count(picture.svg, DRAWN)).toBe(7);
    expect(picture.svg).not.toContain("NaN");
  });

  it("shapes with the font's own rules: a ligature is one glyph", async () => {
    const picture = await app.render({
      font: { artifactId: lato },
      text: "fi",
    });
    expect(count(picture.svg, DRAWN)).toBe(1);
  });

  it("draws nothing for a space, and does not call it missing", async () => {
    const picture = await app.render({
      font: { artifactId: lato },
      text: "a b",
    });
    expect(picture.missing).toEqual([]);
    expect(count(picture.svg, DRAWN)).toBe(2);
  });

  it("shapes each script of a mixed line as that script", async () => {
    const face = harfBuzzReader.open(
      fixtureAt("fonts/NotoSansDevanagari-wdth-wght.ttf").bytes
    );
    const conjunct = face.shape("नमस्ते", { script: "Deva" }).glyphs.length;
    // Shaped as Latin, the same letters stay apart: the conjunct is not formed.
    expect(face.shape("नमस्ते", { script: "Latn" }).glyphs.length).not.toBe(
      conjunct
    );
    face.close();
    const mixed = await app.render({
      font: { artifactId: devanagari },
      text: "Hamburg नमस्ते",
    });
    expect(mixed.missing).toEqual([]);
    expect(count(mixed.svg, DRAWN)).toBe("Hamburg".length + conjunct);
  });

  it("draws a crossed box for each character the font lacks and names each once", async () => {
    const picture = await app.render({
      font: { artifactId: lato },
      text: "日a日न",
    });
    expect(picture.missing).toEqual(["日", "न"]);
    expect(count(picture.svg, CROSSED)).toBe(3);
    expect(count(picture.svg, DRAWN)).toBe(1);
  });

  it("is wider for a longer text and larger at a larger size", async () => {
    const short = await app.render({ font: { artifactId: lato }, text: "Ha" });
    const long = await app.render({
      font: { artifactId: lato },
      text: "Hamburg",
    });
    const large = await app.render({
      font: { artifactId: lato },
      size: 192,
      text: "Ha",
    });
    expect(long.width).toBeGreaterThan(short.width);
    expect(large.height).toBeGreaterThan(short.height);
  });

  it("refuses an artifact that is not there, and one that holds no font", async () => {
    await expect(
      app.render({ font: { artifactId: "nothing-here" }, text: "a" })
    ).rejects.toThrow("There is no artifact nothing-here");
    await expect(
      app.render({ font: { artifactId: photograph }, text: "a" })
    ).rejects.toThrow("does not hold a font that can be read");
    await expect(
      app.render({ font: { artifactId: lato }, size: 0, text: "a" })
    ).rejects.toThrow("more than zero");
  });
});
