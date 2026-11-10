/**
 * The committed data against its source. @unicode/unicode-17.0.0 is read here
 * and in the build script only; the app never imports it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import decodeRanges from "@unicode/unicode-17.0.0/decode-ranges.mjs";
import generalCategories from "@unicode/unicode-17.0.0/General_Category/index.mjs";
import unicode from "@unicode/unicode-17.0.0/index.mjs";
import unicodeNames from "@unicode/unicode-17.0.0/Names/index.mjs";
import { describe, expect, it } from "vitest";
import { blocks, findBlock } from "~/unicode/blocks";
import { categoryName, categoryOf, scriptOf } from "~/unicode/characters";
import { characterName } from "~/unicode/names";
import { charactersIn } from "~/unicode/scope";
import { findScript, scripts, sharedGroups } from "~/unicode/scripts";

const DATA_DIR = path.join(import.meta.dirname, "../../src/unicode/data");
const PACKAGE_DIR = path.join(
  import.meta.dirname,
  "../../../../node_modules/@unicode/unicode-17.0.0"
);
const ENCODED_RANGES = /decodeRanges\('([^']*)'\)/;
const MAX_FILE_BYTES = 900_000;
const MAX_EAGER_BYTES = 60_000;
/** The modules imported statically; every other data file loads on demand. */
const EAGER_FILES = ["properties.ts", "name-chunks.ts"];

const sourceRanges = (property: string, value: string) => {
  const source = readFileSync(
    path.join(PACKAGE_DIR, property, value, "ranges.mjs"),
    "utf8"
  );
  return decodeRanges(ENCODED_RANGES.exec(source)?.[1] ?? "");
};

const sourceCount = (property: string, value: string) =>
  sourceRanges(property, value).reduce((sum, range) => sum + range.length, 0);

describe("committed Unicode data", () => {
  it("has the Unicode 17.0 script counts, stated from Scripts.txt", () => {
    const count = (code: string) => findScript(code)?.characterCount;
    expect(scripts()).toHaveLength(172);
    expect(count("Deva")).toBe(164);
    expect(count("Hebr")).toBe(134);
    expect(count("Grek")).toBe(518);
    expect(count("Cyrl")).toBe(508);
    expect(count("Hang")).toBe(11_739);
  });

  it("matches the source package for every script", () => {
    const source = unicode.Script.filter(
      (name) => !["Common", "Inherited", "Unknown"].includes(name)
    );
    expect(
      scripts()
        .map((script) => script.name.replaceAll(" ", "_"))
        .sort()
    ).toEqual([...source].sort());
    for (const script of scripts()) {
      const name = script.name.replaceAll(" ", "_");
      const expected = sourceRanges("Script", name).flatMap((range) => [
        ...range.keys(),
      ]);
      expect(script.characterCount, name).toBe(expected.length);
      expect(
        [...charactersIn({ code: script.code, kind: "script" })],
        name
      ).toEqual(expected);
    }
  });

  it("accounts for every Common and Inherited character", () => {
    const shared = sharedGroups().reduce(
      (sum, group) => sum + group.characterCount,
      0
    );
    expect(shared).toBe(
      sourceCount("Script", "Common") + sourceCount("Script", "Inherited")
    );
    for (const range of sourceRanges("Script", "Inherited")) {
      expect(scriptOf(range.begin)).toBe("Zinh");
    }
  });

  it("matches the source package for every block", () => {
    const source = unicode.Block.filter((name) => name !== "No_Block");
    expect(blocks()).toHaveLength(source.length);
    expect(blocks()).toHaveLength(346);
    const normalise = (name: string) =>
      name.replaceAll(/[\s_-]/g, "").toLowerCase();
    const byName = new Map(
      blocks().map((block) => [normalise(block.name), block])
    );
    for (const name of source) {
      const [range] = sourceRanges("Block", name);
      const block = byName.get(normalise(name));
      expect(block?.first, name).toBe(range?.begin);
      expect(block?.last, name).toBe((range?.end ?? 0) - 1);
    }
    expect(findBlock("Tags")?.first).toBe(0xe_00_00);
  });

  it("matches the source package's general category everywhere", () => {
    let assigned = 0;
    for (let codePoint = 0; codePoint <= 0x10_ff_ff; codePoint += 1) {
      const category = categoryOf(codePoint);
      const expected = generalCategories.get(codePoint) ?? "Unassigned";
      if (categoryName(category).replaceAll(" ", "_") !== expected) {
        expect.fail(`U+${codePoint.toString(16)}: ${category}, ${expected}`);
      }
      if (category !== "Cn") {
        assigned += 1;
      }
    }
    expect(assigned).toBe(sourceCount("Binary_Property", "Assigned"));
  });

  it("matches the source package for every character name", async () => {
    expect(unicodeNames.size).toBeGreaterThan(159_000);
    for (const [codePoint, name] of unicodeNames) {
      const actual = await characterName(codePoint);
      if (actual !== name) {
        expect.fail(`U+${codePoint.toString(16)}: ${actual}, not ${name}`);
      }
    }
    let unnamed = 0;
    for (let codePoint = 0; codePoint <= 0x10_ff_ff; codePoint += 1) {
      if (
        !unicodeNames.has(codePoint) &&
        (await characterName(codePoint)) !== undefined
      ) {
        unnamed += 1;
      }
    }
    expect(unnamed).toBe(0);
  });

  it("keeps every file small and the eager set smaller", () => {
    const sizes = new Map(
      readdirSync(DATA_DIR).map((file) => [
        file,
        statSync(path.join(DATA_DIR, file)).size,
      ])
    );
    for (const [file, size] of sizes) {
      expect(size, file).toBeLessThan(MAX_FILE_BYTES);
    }
    const eager = EAGER_FILES.reduce(
      (sum, file) => sum + (sizes.get(file) ?? Number.POSITIVE_INFINITY),
      0
    );
    expect(eager).toBeLessThan(MAX_EAGER_BYTES);
  });
});
