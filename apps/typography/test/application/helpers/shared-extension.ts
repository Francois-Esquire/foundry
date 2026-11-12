import { ArtifactManager, InMemoryArtifactStore } from "@foundry/artifacts";
import { type Application, openApplication } from "~/application/application";
import { findProject } from "~/application/store";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { nodeImageCodec } from "~/generation/node-image-codec";
import { fetchedRuns, filesRun } from "~/generation/strategies/recorded/source";
import { nodeFontBuilder } from "~/packaging/engine/node";
import { fixtureFetch } from "../../generate/helpers/session";
import { countingIds, fixedClock } from "../../helpers/fixed";
import { fixtureAt } from "./project";
import { DEVANAGARI_SUBSET, runFiles } from "./twins";

export const EXTENSION = {
  kind: "script-extension",
  plan: "devanagari-subset",
  recordedRun: DEVANAGARI_SUBSET,
} as const;

/** Opens a Node application with the equivalence fixtures and counts every id drawn. */
export const sharedExtension = async () => {
  const artifacts = new ArtifactManager({ store: new InMemoryArtifactStore() });
  const nextId = countingIds();
  let ids = 0;
  const builder = await nodeFontBuilder();
  const open = async () =>
    openApplication(
      {
        artifacts,
        builder,
        clock: fixedClock,
        codec: nodeImageCodec,
        newId: () => {
          ids += 1;
          return nextId();
        },
        reader: harfBuzzReader,
        runAt: (name) => Promise.resolve(filesRun(name, runFiles(name))),
        servedRuns: fetchedRuns("/", fixtureFetch),
        timer: () => fixedClock().getTime(),
      },
      await findProject(artifacts)
    );
  const app = await open();
  const imported = await app.import([fixtureAt("fonts/Lato-Regular.ttf")]);
  const faceId = imported.fonts[0]?.faces[0]?.faceId;
  if (!faceId) {
    throw new Error("Lato was not imported.");
  }
  return {
    app,
    faceId,
    ids: () => ids,
    reopen: async (current: Application) => {
      await current.save();
      await current.close();
      return open();
    },
  };
};
