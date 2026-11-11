import {
  createFamilySession,
  type FamilyMeans,
  type FamilyRunRequest,
} from "~/generate/family/family-session";
import { nodeImageCodec } from "~/generation/node-image-codec";
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
export const sofiaSession = async (means: Partial<FamilyMeans> = {}) => {
  const workspace = testWorkspace();
  const { faceId } = await importOne(workspace, fixtureFile("sofia"));
  let issued = 0;
  const session = createFamilySession({
    codec: nodeImageCodec,
    newId: () => {
      issued += 1;
      return `run-${issued}`;
    },
    workspace,
    ...means,
  });
  const request = (
    patch: Partial<FamilyRunRequest> = {}
  ): FamilyRunRequest => ({
    characters: codes(ACCENTED),
    faceId,
    providerKey: "",
    strategy: "procedural",
    weights: [300, 400, 800],
    ...patch,
  });
  return { faceId, request, session, workspace };
};
