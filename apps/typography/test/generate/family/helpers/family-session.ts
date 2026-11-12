import {
  createFamilySession,
  type FamilyRunRequest,
} from "~/generate/family/family-session";
import { nodeImageCodec } from "~/generation/node-image-codec";
import { countingIds, fixedClock } from "../../../helpers/fixed";
import {
  fixtureFile,
  importOne,
  testWorkspace,
} from "../../../helpers/workspace";

/** Accented letters Sofia Sans lacks and can compose from glyphs it has. */
export const ACCENTED = "ĉĝũǵĤǐ";

export const codes = (text: string) =>
  [...text].map((character) => character.codePointAt(0) ?? 0);

/** A family session over a workspace that holds Sofia Sans, the variable fixture. */
export const sofiaSession = async (
  means: Partial<Parameters<typeof createFamilySession>[0]> = {}
) => {
  const workspace = testWorkspace();
  const { faceId } = await importOne(workspace, fixtureFile("sofia"));
  const session = createFamilySession({
    clock: fixedClock,
    codec: nodeImageCodec,
    newId: countingIds("run"),
    providerKey: () => "",
    workspace,
    ...means,
  });
  const request = (
    patch: Partial<FamilyRunRequest> = {}
  ): FamilyRunRequest => ({
    characters: codes(ACCENTED),
    faceId,
    strategy: "procedural",
    weights: [300, 400, 800],
    ...patch,
  });
  return { faceId, request, session, workspace };
};
