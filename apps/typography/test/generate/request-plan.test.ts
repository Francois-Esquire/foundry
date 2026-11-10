import { describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { withoutCharacters } from "~/generate/hidden-characters";
import { missingInScope } from "~/generate/missing-characters";
import {
  charactersToAsk,
  partsOf,
  planRequest,
  RUN_LIMIT,
  splitByRule,
} from "~/generate/request-plan";
import { emptyReason, noRuleNote } from "~/generate/request-section";
import { proceduralStrategy } from "~/generation/strategies/procedural/procedural";
import { analyseStyle } from "~/generation/style/reference";
import { addedGlyph, type GlyphRef, sourceGlyph } from "~/typeface/changes";
import { fontBytes } from "../helpers/fixtures";

const lato = harfBuzzReader.open(fontBytes("lato"));
const E_ACUTE = 0xe9;
const KA = 0x09_15;
/** The first of a long run of characters Lato lacks, none of which decomposes. */
const FIRST_HAN = 0x4e_00;
/** Devanagari nnna, which is na with a nukta. Lato has neither part. */
const NNNA = 0x09_29;

const inSource = (character: number): GlyphRef | undefined => {
  const glyphId = lato.glyphForCharacter(character);
  return glyphId === undefined ? undefined : sourceGlyph(glyphId);
};

describe("a face with characters hidden", () => {
  it("answers as if it lacked them and leaves the face underneath open", () => {
    const hidden = withoutCharacters(lato, [E_ACUTE]);
    expect(hidden.glyphForCharacter(E_ACUTE)).toBeUndefined();
    expect([...hidden.characters()]).not.toContain(E_ACUTE);
    expect(hidden.glyphForCharacter(0x65)).toBe(lato.glyphForCharacter(0x65));
    hidden.close();
    expect(lato.glyphForCharacter(E_ACUTE)).toBeDefined();
    expect(withoutCharacters(lato, [])).toBe(lato);
  });
});

describe("planning a request", () => {
  it("plans a character the face has as a holdout: hidden, redrawn, compared", () => {
    const plan = planRequest(lato, [E_ACUTE], inSource);
    const [target] = plan.targets;
    expect(plan.heldOut).toEqual([E_ACUTE]);
    expect(plan.face.glyphForCharacter(E_ACUTE)).toBeUndefined();
    expect(target?.replaces).toEqual(inSource(E_ACUTE));
    expect(target?.recipe).toMatchObject({ base: 0x65, kind: "composite" });
    expect(plan.holdouts.get(target?.key ?? "")).toEqual(
      lato.glyph(lato.glyphForCharacter(E_ACUTE) ?? 0)
    );
  });

  it("plans a missing character as an addition with nothing to compare", () => {
    const plan = planRequest(lato, [KA], inSource);
    expect(plan.heldOut).toEqual([]);
    expect(plan.holdouts.size).toBe(0);
    expect(plan.face).toBe(lato);
    expect(plan.targets).toMatchObject([{ characters: [KA], needs: [] }]);
    expect(plan.targets[0]?.replaces).toBeUndefined();
    expect(plan.targets.flatMap((target) => partsOf(target, lato))).toEqual([]);
  });

  it("redraws a glyph the project already added for the character", () => {
    const added = addedGlyph("earlier");
    const plan = planRequest(lato, [KA], (character) =>
      character === KA ? added : inSource(character)
    );
    expect(plan.targets[0]?.replaces).toEqual(added);
    expect(plan.heldOut).toEqual([]);
  });

  it("says what each target is built from and where each part comes from", () => {
    const plan = planRequest(lato, [E_ACUTE, NNNA], inSource);
    const parts = new Map(
      plan.targets.map((target) => [target.key, partsOf(target, plan.face)])
    );
    expect(parts.get("u+00e9")).toEqual([
      { character: 0x65, drawnBy: 0x65, role: "base" },
      {
        character: 0x03_01,
        drawnBy: lato.glyphForCharacter(0x03_01) === undefined ? 0xb4 : 0x03_01,
        role: "mark",
      },
    ]);
    // Lato has no Devanagari, so both parts are targets, made first.
    const order = plan.targets.map((target) => target.key);
    expect(order.at(-1)).toBe("u+0929");
    expect(order).toContain("u+0928");
    expect(order).toContain("u+093c");
    expect(parts.get("u+0929")).toEqual([
      { character: 0x09_28, drawnBy: undefined, role: "base" },
      { character: 0x09_3c, drawnBy: undefined, role: "mark" },
    ]);
  });

  it("takes one run's worth of characters and counts the rest", () => {
    const many = Array.from(
      { length: RUN_LIMIT + 5 },
      (_, index) => FIRST_HAN + index
    );
    const plan = planRequest(lato, [...many, ...many], inSource);
    expect(plan.targets).toHaveLength(RUN_LIMIT);
    expect(plan.deferred).toBe(5);
  });
});

describe("asking the procedural strategy for a writing system's missing characters", () => {
  // Source Code Pro lacks hundreds of Latin characters. A rule can build over
  // a hundred of them from letters and marks it has, and none of those is
  // among the first twenty-four in code point order.
  const mono = harfBuzzReader.open(fontBytes("postscript"));
  const LATIN = { code: "Latn", kind: "script" } as const;
  const inMono = (character: number): GlyphRef | undefined => {
    const glyphId = mono.glyphForCharacter(character);
    return glyphId === undefined ? undefined : sourceGlyph(glyphId);
  };
  const missingNow = (candidates: ReadonlySet<number>) =>
    missingInScope(LATIN, (character) => {
      if (mono.glyphForCharacter(character) !== undefined) {
        return "source";
      }
      return candidates.has(character) ? "candidate" : "missing";
    });

  it("tells the characters a rule can build from the ones that have to be drawn", () => {
    const [buildable] = splitByRule(mono, missingNow(new Set())).buildable;
    if (buildable === undefined) {
      throw new Error("A rule should build some of the missing characters.");
    }
    const split = splitByRule(lato, [KA, NNNA, FIRST_HAN]);
    // No rule for ka or the Han character, and Lato lacks both parts of nnna.
    expect(split).toEqual({
      buildable: [],
      unbuildable: [KA, NNNA, FIRST_HAN],
    });
    expect(splitByRule(mono, [KA, buildable, FIRST_HAN])).toEqual({
      buildable: [buildable],
      unbuildable: [KA, FIRST_HAN],
    });
  });

  it("was stalled: asked for as they come, a run holds only what no rule can build", async () => {
    const missing = missingNow(new Set());
    const { buildable, unbuildable } = splitByRule(mono, missing);
    expect(buildable.length).toBeGreaterThan(2 * RUN_LIMIT);
    expect(unbuildable.length).toBeGreaterThan(RUN_LIMIT);
    const asTheyCome = planRequest(mono, missing, inMono);
    const output = await proceduralStrategy().generate({
      face: asTheyCome.face,
      style: analyseStyle(mono),
      targets: asTheyCome.targets,
    });
    // Nothing is made, so the same characters are missing for the next run.
    expect(output.raw).toMatchObject({ glyphs: [] });
    expect(output.unmade).toHaveLength(asTheyCome.targets.length);
  });

  it("plans a full run of buildable characters, and another full run after it", async () => {
    const style = analyseStyle(mono);
    const proposed = new Set<number>();
    const runs: number[][] = [];
    for (const _run of [1, 2]) {
      const asked = charactersToAsk(mono, missingNow(proposed), {
        source: "script",
        strategy: "procedural",
      });
      const plan = planRequest(mono, asked.characters, inMono);
      expect(plan.targets).toHaveLength(RUN_LIMIT);
      expect(plan.targets.every((target) => target.recipe)).toBe(true);
      expect(asked.noRule).toBeGreaterThan(RUN_LIMIT);
      // "The first 24 of N" counts what a rule can build, and adds up.
      expect(plan.deferred).toBe(asked.characters.length - RUN_LIMIT);
      const output = await proceduralStrategy().generate({
        face: plan.face,
        style,
        targets: plan.targets,
      });
      expect(output.unmade).toEqual([]);
      const made = plan.targets.flatMap((target) => target.characters);
      expect(made).toHaveLength(RUN_LIMIT);
      runs.push(made);
      // Its candidates are proposed, so they are no longer missing.
      for (const character of made) {
        proposed.add(character);
      }
    }
    const [first = [], second = []] = runs;
    expect(second.some((character) => first.includes(character))).toBe(false);
  });

  it("asks a strategy that draws, and a typed list, for exactly what was chosen", () => {
    const missing = missingNow(new Set());
    for (const strategy of ["vector-model", "image-model"] as const) {
      expect(
        charactersToAsk(mono, missing, { source: "script", strategy })
      ).toEqual({ characters: missing, noRule: 0 });
    }
    expect(
      charactersToAsk(mono, [KA, E_ACUTE], {
        source: "typed",
        strategy: "procedural",
      })
    ).toEqual({ characters: [KA, E_ACUTE], noRule: 0 });
    expect(
      charactersToAsk(mono, missing, {
        source: "language",
        strategy: "procedural",
      }).noRule
    ).toBeGreaterThan(0);
  });
});

describe("what the screen says about characters no rule can build", () => {
  const draft = {
    language: "",
    recordedId: "",
    scope: "script:Latn",
    source: "script",
    strategy: "procedural",
    typed: "",
  } as const;

  it("counts them and names the way out", () => {
    expect(noRuleNote(812)).toBe(
      "No rule can build 812 missing characters from glyphs the face has, so the procedural strategy is not asked for them. They have to be drawn: choose a model strategy or a recorded run for them."
    );
    expect(noRuleNote(1)).toContain("1 missing character from");
    expect(noRuleNote(1)).toContain("is not asked for it. It has to be drawn");
  });

  it("does not say the face lacks nothing when every missing character has to be drawn", () => {
    expect(emptyReason(draft, 233)).toBe(
      "No rule can build any of the 233 missing characters from glyphs the face has. Choose a strategy that draws."
    );
    expect(emptyReason(draft)).toBe(
      "The face lacks none of these characters, so there is nothing to generate."
    );
    expect(emptyReason({ ...draft, source: "typed" }, 3)).toBe(
      "Type the characters to generate."
    );
  });
});
