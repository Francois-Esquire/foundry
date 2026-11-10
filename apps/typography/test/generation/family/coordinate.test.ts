/**
 * Coordinated generation across weights, with the real procedural strategy
 * and with small strategies that misbehave in ways a real one can.
 */
import { describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import {
  FamilyGenerationError,
  type FamilyProgress,
  generateAcrossWeights,
} from "~/generation/family/coordinate";
import { proceduralStrategy } from "~/generation/strategies/procedural/procedural";
import {
  type GenerationStrategy,
  type ProducedGlyph,
  type StrategyRequest,
  StrategyUnavailableError,
} from "~/generation/strategies/strategy";
import type { Contour } from "~/typeface/outline";
import { FONTS, fontBytes } from "../../helpers/fixtures";
import { startProject } from "../../packaging/helpers/projects";
import {
  ACCENTED,
  charactersOf,
  FIXED_TIME,
  generateSofiaFamily,
  openSofiaProject,
} from "./helpers/sofia-family";

const EXTRA_POINT =
  /^Contour 1 has \d+ segments in Light and \d+ in ExtraBold\.$/;

const clock = () => new Date(FIXED_TIME);
const procedural = proceduralStrategy({ clock });

/** The procedural strategy with its glyphs changed, weight by weight. */
const altered = (
  change: (
    glyph: ProducedGlyph,
    request: StrategyRequest
  ) => ProducedGlyph | undefined
): GenerationStrategy => ({
  ...procedural,
  async generate(request) {
    const output = await procedural.generate(request);
    if (output.raw.kind !== "outlines") {
      return output;
    }
    const kept: ProducedGlyph[] = [];
    const unmade = [...output.unmade];
    for (const glyph of output.raw.glyphs) {
      const changed = change(glyph, request);
      if (changed) {
        kept.push(changed);
      } else {
        unmade.push({ key: glyph.key, reason: "It was left out on purpose." });
      }
    }
    return { ...output, raw: { glyphs: kept, kind: "outlines" }, unmade };
  },
  id: "altered",
  name: "Procedural, altered for a test",
});

/** The same shape with one more point: the first line gains a point in its middle. */
const withExtraPoint = (contour: Contour): Contour => {
  const at = contour.segments.findIndex((segment) => segment.kind === "line");
  const line = contour.segments[at];
  if (!line) {
    return contour;
  }
  const from = contour.segments[at - 1]?.to ?? contour.start;
  const middle = { x: (from.x + line.to.x) / 2, y: (from.y + line.to.y) / 2 };
  return {
    ...contour,
    segments: [
      ...contour.segments.slice(0, at),
      { kind: "line", to: middle },
      ...contour.segments.slice(at),
    ],
  };
};

const weightOf = (request: StrategyRequest) => request.location?.wght ?? 0;

describe("coordinated generation across weights", () => {
  const sofia = fontBytes("sofia");

  it("pins an instance per weight, lightest first, under the face's own instance names", async () => {
    const { faceId, generation } = await generateSofiaFamily(
      sofia,
      procedural,
      [800, 300, 350, 300, 5000]
    );
    expect(
      generation.instances.map(({ face, weight }) => [
        weight,
        face.pinned?.styleName,
        face.pinned?.location,
      ])
    ).toEqual([
      [300, "Light", { wght: 300 }],
      [350, "wght350", { wght: 350 }],
      [800, "ExtraBold", { wght: 800 }],
      [1000, "wght1000", { wght: 1000 }],
    ]);
    const pinnedIds = generation.instances.map(({ face }) => face.id);
    expect(generation.project.faces.map((face) => face.id)).toEqual([
      faceId,
      ...pinnedIds,
    ]);
    expect(generation.project.candidates).toEqual([]);
  });

  it("makes the same glyphs for every instance, each for its own face", async () => {
    const { generation, plan } = await generateSofiaFamily(sofia);
    expect(plan.targets).toHaveLength([...ACCENTED].length);
    const names = plan.targets.map((target) => target.name);
    const ids = new Set<string>();
    for (const { face, outcome } of generation.instances) {
      if (outcome.status !== "generated") {
        throw new Error(`${face.id} was not generated.`);
      }
      const { candidates, record } = outcome.run;
      expect(record.unmade).toEqual([]);
      expect(candidates.map((candidate) => candidate.name)).toEqual(names);
      expect(candidates.map((candidate) => candidate.characters)).toEqual(
        charactersOf(ACCENTED).map((character) => [character])
      );
      for (const candidate of candidates) {
        expect(candidate.faceId).toBe(face.id);
        expect(candidate.provenance).toMatchObject({
          origin: "generated",
          strategy: "procedural",
        });
        ids.add(candidate.id);
      }
    }
    expect(ids.size).toBe(3 * names.length);
  });

  it("reports the procedural strategy's glyphs as compatible across the instances", async () => {
    const { generation, plan } = await generateSofiaFamily(sofia);
    expect(generation.compatibility).toEqual(
      plan.targets.map((target) => ({
        compatible: true,
        key: target.key,
        name: target.name,
      }))
    );
  });

  it("names the target a strategy drew differently in one instance", async () => {
    const uneven = altered((glyph, request) =>
      glyph.key === "u+0169" && weightOf(request) === 800
        ? {
            ...glyph,
            outline: {
              contours: glyph.outline.contours.map((contour, index) =>
                index === 0 ? withExtraPoint(contour) : contour
              ),
            },
          }
        : glyph
    );
    const { generation } = await generateSofiaFamily(sofia, uneven);
    const report = new Map(
      generation.compatibility.map((entry) => [entry.key, entry])
    );
    expect(report.get("u+0169")).toMatchObject({
      compatible: false,
      name: "uni0169",
    });
    expect(report.get("u+0169")?.reason).toMatch(EXTRA_POINT);
    expect(
      generation.compatibility.filter((entry) => entry.compatible)
    ).toHaveLength([...ACCENTED].length - 1);
  });

  it("gives the reason an instance has no candidate for a target", async () => {
    const patchy = altered((glyph, request) =>
      glyph.key === "u+0109" && weightOf(request) === 400 ? undefined : glyph
    );
    const { generation } = await generateSofiaFamily(sofia, patchy);
    expect(generation.compatibility[0]).toEqual({
      compatible: false,
      key: "u+0109",
      name: "uni0109",
      reason: "Regular has no candidate. It was left out on purpose.",
    });
  });

  it("keeps what was made when a later instance fails, and starts nothing after it", async () => {
    let calls = 0;
    const failing: GenerationStrategy = {
      ...procedural,
      generate(request) {
        calls += 1;
        return weightOf(request) === 400
          ? Promise.reject(new Error("The model answered 503."))
          : procedural.generate(request);
      },
    };
    const progress: FamilyProgress[] = [];
    const { face, faceId, project } = openSofiaProject(sofia);
    const { plan } = await generateSofiaFamily(sofia);
    const generation = await generateAcrossWeights({
      clock,
      face,
      faceId,
      onProgress: (event) => progress.push(event),
      project,
      strategy: failing,
      targets: plan.targets,
      weights: [300, 400, 800],
    });
    expect(calls).toBe(2);
    expect(generation.instances.map(({ outcome }) => outcome.status)).toEqual([
      "generated",
      "failed",
      "not-run",
    ]);
    expect(generation.instances[1]?.outcome).toEqual({
      reason: "The model answered 503.",
      status: "failed",
    });
    expect(generation.compatibility[0]).toMatchObject({
      compatible: false,
      reason: "Regular has no candidate. The model answered 503.",
    });
    expect(
      progress.map((event) => [event.index, event.of, event.status])
    ).toEqual([
      [1, 3, "started"],
      [1, 3, "finished"],
      [2, 3, "started"],
      [2, 3, "finished"],
    ]);
  });

  it("refuses an unavailable strategy before anything runs", async () => {
    const unavailable: GenerationStrategy = {
      ...procedural,
      availability: () => ({
        available: false,
        reason: "No fal API key was supplied.",
      }),
      generate: () => Promise.reject(new Error("It must not be called.")),
    };
    await expect(generateSofiaFamily(sofia, unavailable)).rejects.toEqual(
      new StrategyUnavailableError("No fal API key was supplied.")
    );
  });

  it("stops when the run is cancelled", async () => {
    const controller = new AbortController();
    const cancelling: GenerationStrategy = {
      ...procedural,
      generate() {
        controller.abort();
        return Promise.reject(new Error("Cancelled."));
      },
    };
    const { face, faceId, project } = openSofiaProject(sofia);
    await expect(
      generateAcrossWeights({
        face,
        faceId,
        project,
        signal: controller.signal,
        strategy: cancelling,
        targets: [],
        weights: [300, 800],
      })
    ).rejects.toThrow("Cancelled.");
  });

  it("refuses a face without a weight axis, and fewer than two weights", async () => {
    await expect(generateSofiaFamily(sofia, procedural, [300])).rejects.toEqual(
      new FamilyGenerationError(
        "Coordinated generation needs at least two different weights."
      )
    );
    const first = await generateSofiaFamily(sofia);
    const pinned = first.generation.instances[0]?.face;
    await expect(
      generateAcrossWeights({
        face: first.face,
        faceId: pinned?.id ?? "",
        project: first.generation.project,
        strategy: procedural,
        targets: first.plan.targets,
        weights: [300, 800],
      })
    ).rejects.toEqual(
      new FamilyGenerationError(
        "Sofia Sans Light is a pinned instance. Coordinated weights start from the variable face it was pinned from."
      )
    );
    const lato = fontBytes("lato");
    const statics = startProject(
      FONTS.lato,
      harfBuzzReader.open(lato).description,
      lato
    );
    await expect(
      generateAcrossWeights({
        face: harfBuzzReader.open(lato),
        faceId: statics.faceId,
        project: statics.project,
        strategy: procedural,
        targets: [],
        weights: [300, 800],
      })
    ).rejects.toEqual(
      new FamilyGenerationError(
        "Lato Regular has no weight axis. Coordinated weights need a variable face that has one."
      )
    );
  });
});
