import { glyphRefKey, sourceGlyph } from "~/typeface/changes";
import type { FaceId } from "~/typeface/face";
import { glyphForCharacter } from "~/typeface/glyphs";
import { featureTags } from "~/typeface/layout-features";
import { type TypefaceProject, workingFaceOf } from "~/typeface/project";
import type { OpenFace } from "~/typeface/reading";
import type { Language } from "~/unicode/languages";
import { scopeName } from "~/unicode/scope";
import { findScript } from "~/unicode/scripts";
import { faceFacts } from "./face-facts";
import { type PlanDraft, resolveDraft } from "./plan-draft";
import {
  keepingChosen,
  languageOptions,
  selectionOptions,
} from "./selection-options";
import { type FaceSelection, summariseSelection } from "./selection-summary";
import { characterLookups } from "./unicode-lookups";

/** The choices, selections and resolved fonts of an export draft, without screen state. */
export const planView = (
  project: TypefaceProject,
  draft: PlanDraft,
  reading: (faceId: FaceId) => OpenFace,
  languages: readonly Language[]
) => {
  const facts = faceFacts(project);
  const chosen = facts.filter(({ face }) => draft.faceIds.includes(face.id));
  const labels = new Map(
    facts.map(({ face, listLabel }) => [face.id, listLabel])
  );
  const { resolution, typingProblems } = resolveDraft(
    project,
    draft,
    characterLookups(languages, (faceId) => reading(faceId).characters())
  );
  const prepared = chosen.map((fact) => {
    const source = reading(fact.face.id);
    const working = workingFaceOf(project, fact.face.id);
    return {
      ...fact,
      characters: [...source.characters(), ...working.characters.keys()],
      source,
      working,
    };
  });
  const held = prepared.flatMap(({ characters }) => characters);
  const offered = selectionOptions(held);
  const options = {
    blocks: keepingChosen(offered.blocks, draft.blocks, (name) => name),
    scripts: keepingChosen(
      offered.scripts,
      draft.scripts,
      (code) => findScript(code)?.name ?? code
    ),
    sharedGroups: keepingChosen(
      offered.sharedGroups,
      draft.sharedGroups,
      (group) => scopeName({ group, kind: "shared" })
    ),
  };
  const languageChoices = keepingChosen(
    languageOptions(languages, held),
    draft.languages,
    (tag) => languages.find((language) => language.tag === tag)?.name ?? tag
  );
  const selections = prepared.map(
    ({
      face,
      listLabel: label,
      source,
      working,
      characters,
    }): FaceSelection => {
      const output = resolution.outputs.find(
        (candidate) => candidate.faceId === face.id
      );
      return {
        faceId: face.id,
        label,
        summary: summariseSelection({
          available: characters,
          fallbackGlyph: glyphRefKey(sourceGlyph(0)),
          glyphCount: face.description.glyphCount + working.added.length,
          glyphOf: (character) => {
            const glyph = glyphForCharacter(working, source, character);
            return glyph && glyphRefKey(glyph);
          },
          kept:
            output?.kind === "derived"
              ? output.request.subset?.characters
              : undefined,
        }),
      };
    }
  );
  const tags = [
    ...new Set(
      prepared.flatMap(({ face, working }) =>
        featureTags(face.description.layout, working.featureCode)
      )
    ),
  ].sort();
  return {
    chosen,
    facts,
    labels,
    languageChoices,
    options,
    resolution,
    selections,
    tags,
    typingProblems,
  };
};
