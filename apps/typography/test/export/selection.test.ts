import { describe, expect, it } from "vitest";
import {
  keepingChosen,
  languageOptions,
  matchingOptions,
  selectionOptions,
} from "~/export/selection-options";
import { summariseSelection } from "~/export/selection-summary";
import { shapingSamples } from "~/export/shaping-samples";
import { languages } from "~/unicode/languages";
import { span } from "../packaging/helpers/projects";
import { charactersOf } from "../packaging/helpers/requests";

const ASCII = span(0x20, 0x7e);
const GREEK_CAPITALS = span(0x03_91, 0x03_a1);

describe("what a selection can be made from", () => {
  it("offers the scripts, shared groups and blocks the characters belong to", () => {
    const options = selectionOptions([...ASCII, ...GREEK_CAPITALS, 0x41]);
    expect(options.scripts).toEqual([
      { count: 52, name: "Latin", value: "Latn" },
      { count: 17, name: "Greek", value: "Grek" },
    ]);
    expect(
      options.sharedGroups.map(({ count, value }) => [value, count])
    ).toEqual([
      ["digits", 10],
      ["punctuation", 23],
      ["symbols", 9],
      ["controls", 1],
    ]);
    expect(options.blocks).toEqual([
      { count: 95, name: "Basic Latin", value: "Basic Latin" },
      { count: 17, name: "Greek and Coptic", value: "Greek and Coptic" },
    ]);
  });

  it("offers a language only when all its everyday characters are held", async () => {
    const all = await languages();
    const tags = (characters: readonly number[]) =>
      languageOptions(all, characters).map((option) => option.value);
    expect(tags(ASCII)).toContain("en");
    expect(tags(ASCII)).not.toContain("el");
    expect(tags(ASCII)).not.toContain("pl");
    expect(tags(ASCII.filter((character) => character !== 0x7a))).not.toContain(
      "en"
    );
  });

  it("keeps a chosen value in sight when the faces no longer hold it", () => {
    const { scripts } = selectionOptions(ASCII);
    expect(
      keepingChosen(scripts, ["Latn", "Deva"], (code) => `Script ${code}`)
    ).toEqual([
      { count: 52, name: "Latin", value: "Latn" },
      { count: 0, name: "Script Deva", value: "Deva" },
    ]);
  });

  it("finds options by part of a name or by the whole tag", () => {
    const options = [
      { count: 1, name: "Hindi", value: "hi" },
      { count: 1, name: "Polish", value: "pl" },
    ];
    expect(matchingOptions(options, " hin ")).toEqual([options[0]]);
    expect(matchingOptions(options, "PL")).toEqual([options[1]]);
    expect(matchingOptions(options, "")).toEqual(options);
    expect(matchingOptions(options, "h")).toEqual(options);
  });
});

describe("what a selection comes to for one face", () => {
  const glyphOf = (character: number) =>
    // Capital and small a share a glyph here, and b has none of its own.
    ({ 65: "s:5", 97: "s:5", 913: "s:9" })[character];

  it("keeps everything exactly when nothing is selected", () => {
    expect(
      summariseSelection({
        available: [0x41, 0x61, 0x62, 0x03_91],
        fallbackGlyph: "s:0",
        glyphCount: 40,
        glyphOf,
        kept: undefined,
      })
    ).toEqual({
      available: 4,
      glyphFloor: 40,
      glyphsExact: true,
      kept: 4,
      leftOut: [],
      leftOutCount: 0,
    });
  });

  it("counts distinct glyphs with the fallback, and groups what is left out", () => {
    expect(
      summariseSelection({
        available: [0x41, 0x61, 0x62, 0x03_91, 0x30, 0x31, 0xe0_00],
        fallbackGlyph: "s:0",
        glyphCount: 40,
        glyphOf,
        kept: [0x41, 0x61],
      })
    ).toEqual({
      available: 7,
      glyphFloor: 2,
      glyphsExact: false,
      kept: 2,
      leftOut: [
        { count: 2, name: "Digits and numbers" },
        { count: 1, name: "Greek" },
        { count: 1, name: "Latin" },
        { count: 1, name: "Other characters" },
      ],
      leftOutCount: 5,
    });
  });
});

describe("sample texts for the kept scripts", () => {
  it("uses the texts on file that the kept characters can set", () => {
    const samples = shapingSamples(charactersOf("office AVfi"));
    expect(samples.map((entry) => entry.sample.text)).toEqual([
      "office",
      "fi",
      "AV",
    ]);
    expect(samples[0]).toEqual({
      generic: false,
      sample: {
        options: { direction: "ltr", language: "en", script: "Latn" },
        text: "office",
      },
      scriptName: "Latin",
    });
  });

  it("falls back to the kept letters, and says so, when no text on file fits", () => {
    expect(shapingSamples(charactersOf("xyz 12"))).toEqual([
      {
        generic: true,
        sample: {
          options: { direction: "ltr", language: "en", script: "Latn" },
          text: "xyz",
        },
        scriptName: "Latin",
      },
    ]);
  });

  it("gives every script its own samples, right to left where the script is", () => {
    const samples = shapingSamples([
      ...charactersOf("fi"),
      ...charactersOf("لا"),
      ...charactersOf("क्ष"),
      // Armenian has no texts on file.
      0x05_31,
      0x05_32,
    ]);
    expect(
      samples.map(({ generic, sample, scriptName }) => [
        scriptName,
        sample.text,
        sample.options?.direction,
        generic,
      ])
    ).toEqual([
      ["Latin", "fi", "ltr", false],
      ["Arabic", "لا", "rtl", false],
      ["Devanagari", "क्ष", "ltr", false],
      ["Armenian", "ԱԲ", "ltr", true],
    ]);
  });

  it("has nothing to shape without letters", () => {
    expect(shapingSamples(charactersOf("12 !"))).toEqual([]);
  });
});

it("Keeps generic shaping samples language-free for scripts with only specimen words", () => {
  expect(shapingSamples([0x09_95])).toEqual([
    {
      generic: true,
      sample: {
        options: { direction: "ltr", language: undefined, script: "Beng" },
        text: "ক",
      },
      scriptName: "Bengali",
    },
  ]);
});
