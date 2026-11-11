/**
 * The procedural strategy: builds missing glyphs from the ones a face has,
 * by rule, on this machine. No model is involved and nothing leaves it.
 */
import { roundOutline } from "~/typeface/outline";
import type { GlyphTarget } from "../../plan/target";
import type {
  GenerationStrategy,
  ProducedGlyph,
  StrategyOutput,
  StrategyRequest,
} from "../strategy";
import { composeComposite, type PartSource, partFor } from "./composite";
import { obliqueOf, smallCapitalOf } from "./derivatives";

export interface ProceduralOptions {
  /** Says when the glyphs were made, and times the making. */
  readonly clock: () => Date;
  /**
   * Characters whose glyphs the strategy must not read. A holdout test names
   * the character under test here, so the face's own answer cannot leak in.
   */
  readonly exclude?: readonly number[];
  /**
   * Place marks the way the face's own accented letters do, when it has any
   * with the same mark. On by default. Off, marks are placed from the bounds
   * of the base and the lines of the face alone.
   */
  readonly learnFromComposites?: boolean;
}

type Made =
  | { readonly glyph: Omit<ProducedGlyph, "key"> }
  | { readonly reason: string };

const NO_RECIPE =
  "No rule builds this glyph from existing ones. It needs a strategy that draws.";

const make = (
  target: GlyphTarget,
  request: StrategyRequest,
  source: PartSource
): Made => {
  const { recipe } = target;
  if (!recipe) {
    return { reason: NO_RECIPE };
  }
  if (recipe.kind === "composite") {
    const composite = composeComposite(source, recipe.base, recipe.marks);
    return "missing" in composite
      ? { reason: `The face has no glyph for ${composite.missing}.` }
      : { glyph: composite };
  }
  if (recipe.kind === "oblique") {
    return {
      glyph: obliqueOf(
        request.face.glyph(recipe.glyphId, request.location),
        recipe.angle
      ),
    };
  }
  const capital = partFor(source, recipe.capital);
  return capital
    ? { glyph: smallCapitalOf(capital.shape, request.style) }
    : { reason: "The face has no capital to scale." };
};

export const proceduralStrategy = (
  options: ProceduralOptions
): GenerationStrategy => ({
  availability: () => ({ available: true }),
  generate(request): Promise<StrategyOutput> {
    const started = options.clock();
    const source: PartSource = {
      exclude: new Set(options.exclude),
      face: request.face,
      learnFromComposites: options.learnFromComposites ?? true,
      location: request.location,
      style: request.style,
    };
    const glyphs: ProducedGlyph[] = [];
    const unmade: { key: string; reason: string }[] = [];
    for (const target of request.targets) {
      const made = make(target, request, source);
      if ("reason" in made) {
        unmade.push({ key: target.key, reason: made.reason });
      } else {
        glyphs.push({
          ...made.glyph,
          advance: Math.round(made.glyph.advance),
          key: target.key,
          outline: roundOutline(made.glyph.outline),
        });
      }
    }
    return Promise.resolve({
      createdAt: started.toISOString(),
      producedBy: "procedural",
      raw: { glyphs, kind: "outlines" },
      recorded: false,
      unmade,
      usage: { latencyMs: options.clock().getTime() - started.getTime() },
    });
  },
  id: "procedural",
  kind: "procedural",
  name: "Procedural: built by rule from existing glyphs",
});
