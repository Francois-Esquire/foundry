import { ArtifactManager, InMemoryArtifactStore } from "@foundry/artifacts";
import { openApplication } from "~/application/application";
import type { ApplicationMeans } from "~/application/means";
import { NO_RECORDED_RUNS } from "~/application/served-run";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { nodeImageCodec } from "~/generation/node-image-codec";
import type { FontBuilder } from "~/packaging/building";
import { FIXED_TIME } from "./workspace";

const unused = (): never => {
  throw new Error("This test's application builds no font.");
};

/** A builder that fails when touched, whatever the port grows to hold. */
const untouchedBuilder = new Proxy({}, { get: () => unused }) as FontBuilder;

/**
 * An application opened the way the browser opens it: an empty project whose
 * artifacts are kept in memory. The reader is the real one. The clock is
 * fixed and ids count up from id-1, as in `testWorkspace`. `means` replaces
 * any of that, such as the builder for a test that builds.
 */
export const testApplication = (means: Partial<ApplicationMeans> = {}) => {
  let issued = 0;
  return openApplication({
    artifacts: new ArtifactManager({ store: new InMemoryArtifactStore() }),
    builder: untouchedBuilder,
    codec: nodeImageCodec,
    newId: () => {
      issued += 1;
      return `id-${issued}`;
    },
    now: () => FIXED_TIME,
    reader: harfBuzzReader,
    readRecordedRun: () =>
      Promise.reject(new Error("This test's application reads no run.")),
    servedRuns: NO_RECORDED_RUNS,
    timer: () => Date.parse(FIXED_TIME),
    ...means,
  });
};
