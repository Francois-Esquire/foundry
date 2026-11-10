import { DEVANAGARI_OFFERING } from "~/generate/script-extension/offering";
import {
  createScriptExtensionSession,
  type SessionMeans,
} from "~/generate/script-extension/session";
import { nodeImageCodec } from "../../../../scripts/generation/node-image-codec";
import {
  fixtureFile,
  importOne,
  testWorkspace,
} from "../../../helpers/workspace";
import { fixtureFetch } from "../../helpers/session";

/** A script extension session over a workspace that holds Lato, replaying the fixture runs. */
export const latoExtensionSession = async (
  means: Partial<SessionMeans> = {}
) => {
  const workspace = testWorkspace();
  const { faceId } = await importOne(workspace, fixtureFile("lato"));
  let issued = 0;
  const session = createScriptExtensionSession({
    base: "/",
    codec: nodeImageCodec,
    fetch: fixtureFetch,
    newId: () => {
      issued += 1;
      return `extension-${issued}`;
    },
    offering: DEVANAGARI_OFFERING,
    workspace,
    ...means,
  });
  return { faceId, session, workspace };
};
