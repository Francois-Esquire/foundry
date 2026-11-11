import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { DEVANAGARI_OFFERING } from "~/generate/script-extension/offering";
import {
  createScriptExtensionSession,
  type SessionMeans,
} from "~/generate/script-extension/session";
import { nodeImageCodec } from "~/generation/node-image-codec";
import { fetchedRuns } from "~/generation/strategies/recorded/source";
import { nodeFontBuilder } from "~/packaging/engine/node";
import { countingIds, fixedClock } from "../../../helpers/fixed";
import {
  fixtureFile,
  importOne,
  testWorkspace,
} from "../../../helpers/workspace";
import { fixtureFetch } from "../../helpers/session";

/** The real font engine, started by the first verification and by nothing else. */
const builder: SessionMeans["builder"] = {
  build: async (request) => (await nodeFontBuilder()).build(request),
  validate: async (font) => (await nodeFontBuilder()).validate(font),
};

/** A script extension session over a workspace that holds Lato, replaying the fixture runs. */
export const latoExtensionSession = async (
  means: Partial<SessionMeans> = {}
) => {
  const workspace = testWorkspace();
  const { faceId } = await importOne(workspace, fixtureFile("lato"));
  const session = createScriptExtensionSession({
    builder,
    clock: fixedClock,
    codec: nodeImageCodec,
    newId: countingIds("extension"),
    offering: DEVANAGARI_OFFERING,
    reader: harfBuzzReader,
    runs: fetchedRuns("/", fixtureFetch),
    timer: () => performance.now(),
    workspace,
    ...means,
  });
  return { faceId, session, workspace };
};
