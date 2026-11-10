import { readFaceCoverage } from "~/library/face-coverage";
import type { FONTS } from "../../helpers/fixtures";
import { fixtureFile, importOne, testWorkspace } from "../../helpers/workspace";

/** Imports one fixture into a fresh workspace and reads what its face covers. */
export const fixtureCoverage = async (name: keyof typeof FONTS) => {
  const workspace = testWorkspace();
  const { faceId } = await importOne(workspace, fixtureFile(name));
  const coverage = readFaceCoverage(
    workspace.getState().project,
    faceId,
    workspace.openFace(faceId)
  );
  return { coverage, faceId, workspace };
};
