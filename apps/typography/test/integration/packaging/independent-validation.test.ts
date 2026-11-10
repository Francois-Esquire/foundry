/**
 * Fonts built by the engine, handed to tools that share nothing with it:
 * native fontTools, the OpenType Sanitizer and native HarfBuzz, all run by
 * scripts/validate-font.py through uv. Needs uv on PATH, and the network the
 * first time, when uv fetches the three wheels.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import type { BuildRequest, FontBuilder } from "~/packaging/building";
import { nodeFontBuilder } from "~/packaging/engine/node";
import { fontBytes, TRIANGLE } from "../../helpers/fixtures";
import { withDamagedTable } from "../../packaging/helpers/damage";
import {
  charactersOf,
  glyphOf,
  requestFor,
} from "../../packaging/helpers/requests";

const APP_ROOT = path.join(import.meta.dirname, "../../..");
const PRESCRIBED = ["--with", "fonttools", "--with", "opentype-sanitizer"];
const WITH_SHAPER = [...PRESCRIBED, "--with", "uharfbuzz"];
const CONJUNCT = "क्ष";

interface IndependentReport {
  readonly accepted: boolean;
  readonly characters?: { readonly missing: readonly string[] };
  readonly error?: string;
  readonly fontTools: {
    readonly accepted: boolean;
    readonly axes?: readonly string[];
    readonly characterCount?: number;
    readonly familyName?: string;
    readonly glyphCount?: number;
    readonly problems: readonly { readonly table: string | null }[];
    readonly styleName?: string;
    readonly tables?: readonly string[];
  };
  readonly packed: boolean;
  readonly sanitizer: {
    readonly accepted: boolean;
    readonly discardedTables: readonly string[];
    readonly messages: readonly string[];
  };
  readonly shaping?: {
    readonly available: boolean;
    readonly glyphs?: readonly { readonly cluster: number }[];
    readonly reason?: string;
  };
}

const uvIsInstalled = spawnSync("uv", ["--version"]).status === 0;
if (!uvIsInstalled) {
  console.warn(
    "Skipped the independent font validation: uv is not on PATH. Install uv (https://docs.astral.sh/uv) to run it."
  );
}

const formatCharacters = (characters: readonly number[]) =>
  characters.map((character) => `U+${character.toString(16)}`).join(",");

describe.skipIf(!uvIsInstalled)("independent validation of built fonts", () => {
  const lato = fontBytes("lato");
  const devanagari = fontBytes("devanagari");
  const postscript = fontBytes("postscript");
  let builder: FontBuilder;
  let directory: string;
  let files = 0;

  const run = (
    font: Uint8Array,
    options: readonly string[],
    packages = WITH_SHAPER
  ) => {
    files += 1;
    const file = path.join(directory, `font-${files}`);
    writeFileSync(file, font);
    const result = spawnSync(
      "uv",
      [
        "run",
        "--no-project",
        ...packages,
        "python",
        "-I",
        "scripts/validate-font.py",
        file,
        ...options,
      ],
      { cwd: APP_ROOT, encoding: "utf8" }
    );
    if (!result.stdout.trim()) {
      throw new Error(`The validator printed no report: ${result.stderr}`);
    }
    return {
      exitCode: result.status,
      report: JSON.parse(result.stdout) as IndependentReport,
    };
  };

  /** Builds a font and expects every independent tool to accept it. */
  const accept = async (
    request: BuildRequest,
    text: string,
    characters: readonly number[]
  ) => {
    const built = await builder.build(request);
    const { exitCode, report } = run(built.bytes, [
      "--expect-chars",
      formatCharacters(characters),
      "--shape",
      text,
    ]);
    expect(report.fontTools.problems).toEqual([]);
    expect(report.sanitizer.messages).toEqual([]);
    expect(report.sanitizer.discardedTables).toEqual([]);
    expect(report.characters?.missing).toEqual([]);
    expect(report.accepted).toBe(true);
    expect(exitCode).toBe(0);
    expect(report.fontTools.glyphCount).toBe(built.glyphCount);
    expect(report.fontTools.characterCount).toBe(built.characterCount);
    return { built, report };
  };

  /** Native HarfBuzz and the app's HarfBuzz have to group the text the same way. */
  const expectSameShaping = (
    report: IndependentReport,
    font: Uint8Array,
    text: string
  ) => {
    expect(report.shaping?.available).toBe(true);
    expect(report.shaping?.glyphs?.map((glyph) => glyph.cluster)).toEqual(
      harfBuzzReader
        .open(font)
        .shape(text)
        .glyphs.map((glyph) => glyph.cluster)
    );
  };

  beforeAll(async () => {
    builder = await nodeFontBuilder();
    directory = mkdtempSync(path.join(tmpdir(), "typography-validate-"));
  });

  afterAll(() => {
    rmSync(directory, { force: true, recursive: true });
  });

  it("accepts an edited font with an added glyph and grafted features", async () => {
    const latoFace = harfBuzzReader.open(lato);
    const { glyphNames } = await builder.describeLayout(lato);
    const a = glyphOf(latoFace, "a");
    const request = requestFor(lato, {
      added: [
        {
          advance: 1000,
          characters: [0xe0_00],
          key: "triangle",
          name: "triangle",
          outline: TRIANGLE,
          provenance: { origin: "manual" },
        },
      ],
      familyName: "Atlas Sans",
      featureCode: [
        `languagesystem DFLT dflt; languagesystem latn dflt;
feature liga { sub ${glyphNames[a]} ${glyphNames[glyphOf(latoFace, "b")]} by triangle; } liga;`,
      ],
      overrides: new Map([[a, { advance: 1300, outline: TRIANGLE }]]),
    });
    const { built, report } = await accept(request, "abfi", [0x61, 0xe0_00]);
    expect(report.fontTools.familyName).toBe("Atlas Sans");
    expect(report.shaping?.glyphs).toHaveLength(2);
    expectSameShaping(report, built.bytes, "abfi");
  });

  it("accepts a pinned and subset Devanagari instance that still forms its conjunct", async () => {
    const request = requestFor(devanagari, {
      familyName: "Atlas Devanagari",
      location: { wght: 700 },
      styleName: "Bold",
      subset: { characters: charactersOf(CONJUNCT) },
    });
    const { built, report } = await accept(
      request,
      CONJUNCT,
      charactersOf(CONJUNCT)
    );
    expect(report.fontTools.axes).toEqual([]);
    expect(report.fontTools.styleName).toBe("Bold");
    expect(report.shaping?.glyphs).toHaveLength(1);
    expectSameShaping(report, built.bytes, CONJUNCT);
  });

  it("accepts a subset that stays variable", async () => {
    const request = requestFor(devanagari, {
      subset: { characters: charactersOf(CONJUNCT) },
    });
    const { report } = await accept(request, CONJUNCT, charactersOf(CONJUNCT));
    expect(report.fontTools.axes).toEqual(["wght", "wdth"]);
    expect(report.fontTools.tables).toEqual(
      expect.arrayContaining(["fvar", "gvar"])
    );
    expect(report.shaping?.glyphs).toHaveLength(1);
  });

  it("accepts a WOFF2 file, unpacked by the sanitizer and then read by fontTools", async () => {
    const request = requestFor(lato, {
      familyName: "Atlas Sans",
      flavor: "woff2",
      subset: { characters: charactersOf("office") },
    });
    const { built, report } = await accept(
      request,
      "office",
      charactersOf("office")
    );
    expect(report.packed).toBe(true);
    // fi and ff are ligatures: six characters, four glyphs, also after unpacking.
    expect(report.shaping?.glyphs).toHaveLength(4);
    expect(built.bytes.byteLength).toBeLessThan(10_000);
  });

  it("accepts PostScript outlines converted to TrueType, and PostScript outlines kept", async () => {
    const a = glyphOf(harfBuzzReader.open(postscript), "a");
    const converted = await accept(
      requestFor(postscript, {
        familyName: "Atlas Mono",
        overrides: new Map([[a, { outline: TRIANGLE }]]),
      }),
      "code",
      charactersOf("code")
    );
    expect(converted.report.fontTools.tables).toContain("glyf");
    expect(converted.report.fontTools.tables).not.toContain("CFF ");
    const kept = await accept(
      requestFor(postscript, {
        familyName: "Atlas Mono",
        subset: { characters: charactersOf("code") },
      }),
      "code",
      charactersOf("code")
    );
    expect(kept.report.fontTools.tables).toContain("CFF ");
  });

  it("says shaping is unavailable when run exactly as documented, without a shaper", async () => {
    const built = await builder.build(
      requestFor(lato, { subset: { characters: charactersOf("fi") } })
    );
    const { exitCode, report } = run(
      built.bytes,
      ["--shape", "fi"],
      PRESCRIBED
    );
    expect(exitCode).toBe(0);
    expect(report.accepted).toBe(true);
    expect(report.shaping).toEqual({
      available: false,
      reason: "No shaper is installed. Add --with uharfbuzz to shape text.",
    });
  });

  it("rejects a font with a damaged table", async () => {
    const built = await builder.build(
      requestFor(lato, { subset: { characters: charactersOf("fiAV") } })
    );
    const { exitCode, report } = run(withDamagedTable(built.bytes, "GPOS"), []);
    expect(exitCode).toBe(1);
    expect(report.accepted).toBe(false);
    expect(report.fontTools.accepted).toBe(false);
    expect(report.fontTools.problems.map((problem) => problem.table)).toEqual([
      "GPOS",
    ]);
    expect(report.sanitizer.accepted).toBe(false);
  });

  it("answers a badly written option with a report, not a traceback", async () => {
    const built = await builder.build(
      requestFor(lato, { subset: { characters: charactersOf("fi") } })
    );
    const { exitCode, report } = run(built.bytes, [
      "--expect-chars",
      "U+0041,latin",
    ]);
    expect(exitCode).toBe(1);
    expect(report).toMatchObject({
      accepted: false,
      error:
        "Write --expect-chars as code points with commas between them, for example U+0041,U+0915.",
    });
  });

  it("rejects a sound font that lacks an expected character", async () => {
    const built = await builder.build(
      requestFor(lato, { subset: { characters: charactersOf("fi") } })
    );
    const { exitCode, report } = run(built.bytes, [
      "--expect-chars",
      "U+0066,U+0915",
    ]);
    expect(exitCode).toBe(1);
    expect(report.fontTools.accepted).toBe(true);
    expect(report.sanitizer.accepted).toBe(true);
    expect(report.characters?.missing).toEqual(["U+0915"]);
    expect(report.accepted).toBe(false);
  });
});
