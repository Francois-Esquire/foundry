/**
 * A project a screen and a command both work on: one set of artifacts, kept
 * in memory, that outlasts the application opened over it. The recorded runs
 * are served for a screen's sessions and found by name for a command, as in
 * `twins.ts`, so a run made one way can be looked for the other way after
 * the project is saved and opened again.
 */
import { ArtifactManager, InMemoryArtifactStore } from "@foundry/artifacts";
import { type Application, openApplication } from "~/application/application";
import { findProject } from "~/application/artifact-store";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { nodeImageCodec } from "~/generation/node-image-codec";
import { fetchedRuns, filesRun } from "~/generation/strategies/recorded/source";
import { fixtureFetch } from "../../generate/helpers/session";
import { countingIds, fixedClock } from "../../helpers/fixed";
import { fixtureAt } from "./project";
import { builder, runFiles } from "./twins";

export const MODEL_OUTPUT = "application/vnd.foundry.typography.model-output";
export const PHOTOGRAPH = "application/vnd.foundry.typography.photograph";

const heldProject = () => {
  const artifacts = new ArtifactManager({ store: new InMemoryArtifactStore() });
  const newId = countingIds();
  const open = async (): Promise<Application> =>
    openApplication(
      {
        artifacts,
        builder,
        clock: fixedClock,
        codec: nodeImageCodec,
        newId,
        reader: harfBuzzReader,
        runAt: (name) => Promise.resolve(filesRun(name, runFiles(name))),
        servedRuns: fetchedRuns("/", fixtureFetch),
        timer: () => fixedClock().getTime(),
      },
      await findProject(artifacts)
    );
  return {
    /** The ids of the artifacts of one type, in the order they are listed. */
    idsOf: async (type: string): Promise<string[]> =>
      (await artifacts.list({ type })).items.map((artifact) => artifact.id),
    open,
    /** Saves, closes and opens again over the same artifacts. */
    reopen: async (app: Application): Promise<Application> => {
      await app.save();
      await app.close();
      return open();
    },
  };
};

/** Opens a held project and imports Lato into it. */
export const heldLato = async () => {
  const held = heldProject();
  const app = await held.open();
  const imported = await app.import([fixtureAt("fonts/Lato-Regular.ttf")]);
  const faceId = imported.fonts[0]?.faces[0]?.faceId;
  if (!faceId) {
    throw new Error("Lato was not imported.");
  }
  return { ...held, app, faceId };
};
