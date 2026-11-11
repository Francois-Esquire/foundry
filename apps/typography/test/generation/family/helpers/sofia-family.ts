/**
 * Sofia Sans extended across three weights by the procedural strategy: the
 * shared starting point of the family tests. Nothing here touches the file
 * system, so the Chrome engine page can run it too.
 */
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import {
  type FamilyGeneration,
  generateAcrossWeights,
} from "~/generation/family/coordinate";
import { planCharacters } from "~/generation/plan/plan";
import { proceduralStrategy } from "~/generation/strategies/procedural/procedural";
import type { GenerationStrategy } from "~/generation/strategies/strategy";
import {
  acceptCandidate,
  addSource,
  emptyProject,
  propose,
  type TypefaceProject,
} from "~/typeface/project";
import { countingIds, FIXED_TIME, fixedClock } from "../../../helpers/fixed";

/** Accented letters Sofia Sans lacks and can compose from glyphs it has. */
export const ACCENTED = "ĉĝũǵĤǐ";
export const FAMILY_WEIGHTS = [300, 400, 800] as const;

export const charactersOf = (text: string) =>
  [...text].map((character) => character.codePointAt(0) ?? 0);

export const openSofiaProject = (sofia: Uint8Array) => {
  const face = harfBuzzReader.open(sofia);
  const project = addSource(
    emptyProject("Sofia family"),
    {
      bytes: sofia,
      fileName: "SofiaSans-wght.ttf",
      id: "sofia-sans-digest".padEnd(64, "0"),
      importedAt: FIXED_TIME,
    },
    [face.description]
  );
  const faceId = project.faces[0]?.id ?? "";
  return { face, faceId, project };
};

export const generateSofiaFamily = async (
  sofia: Uint8Array,
  strategy: GenerationStrategy = proceduralStrategy({
    clock: fixedClock,
  }),
  weights: readonly number[] = FAMILY_WEIGHTS
) => {
  const { face, faceId, project } = openSofiaProject(sofia);
  const plan = planCharacters(face, charactersOf(ACCENTED));
  const generation = await generateAcrossWeights({
    clock: fixedClock,
    face,
    faceId,
    newId: countingIds("run"),
    project,
    strategy,
    targets: plan.targets,
    weights,
  });
  return { face, faceId, generation, plan };
};

/** Proposes every candidate the family generation made and accepts each one. */
export const acceptEverything = (
  generation: FamilyGeneration
): TypefaceProject => {
  const candidates = generation.instances.flatMap(({ outcome }) =>
    outcome.status === "generated" ? outcome.run.candidates : []
  );
  let project = propose(generation.project, candidates);
  for (const [index, candidate] of candidates.entries()) {
    project = acceptCandidate(project, candidate.id, {
      at: FIXED_TIME,
      id: `accept-${index}`,
    });
  }
  return project;
};
