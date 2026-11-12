import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ArtifactManager, InMemoryArtifactStore } from "@foundry/artifacts";
import { createArtifactStore } from "~/application/artifact-store";
import { nodeImageCodec } from "~/generation/node-image-codec";
import { fetchedRuns } from "~/generation/strategies/recorded/source";
import { nodeFontBuilder } from "~/packaging/engine/node";
import { rectangle } from "~/reconstruct/core";
import type { Fetch } from "~/reconstruct/samples";
import {
  createReconstructSession,
  type SessionMeans,
} from "~/reconstruct/session";
import { countingIds, fixedClock } from "../../helpers/fixed";
import { fixtureFile, importOne, testWorkspace } from "../../helpers/workspace";

const FIXTURES = path.join(import.meta.dirname, "../../fixtures");
const MOUNTS: Readonly<Record<string, string>> = {
  evidence: path.join(FIXTURES, "evidence"),
  "recorded-runs": path.join(FIXTURES, "generation"),
};

export const STOREFRONT = "storefront-needed-things.jpg";
export const HANDWRITING = "handwriting-defg.jpg";

/** The lettering of the storefront banner, inside the banner's edge. */
export const BANNER = rectangle(432, 162, 400, 196);

export const evidenceFile = (fileName: string) => ({
  bytes: new Uint8Array(
    readFileSync(path.join(FIXTURES, "evidence", fileName))
  ),
  fileName,
});

/** Serves the evidence and recorded-run fixtures the way the app's server does, from disk. */
export const fixtureFetch: Fetch = (address) => {
  const [, route = "", ...rest] = address.split("/");
  const directory = MOUNTS[route];
  const name = decodeURIComponent(rest.join("/"));
  if (!directory) {
    return Promise.resolve(new Response(null, { status: 404 }));
  }
  if (route === "recorded-runs" && name === "index.json") {
    return Promise.resolve(
      Response.json(
        readdirSync(directory).filter((run) =>
          existsSync(path.join(directory, run, "run.json"))
        )
      )
    );
  }
  const file = path.join(directory, name);
  return Promise.resolve(
    existsSync(file)
      ? new Response(new Uint8Array(readFileSync(file)))
      : new Response(null, { status: 404 })
  );
};

/** The real font engine, started only by a test that makes a new face. */
const builder: SessionMeans["builder"] = {
  blankFont: async (request) => (await nodeFontBuilder()).blankFont(request),
};

/**
 * A session over a workspace that holds Lato and Sofia Sans.
 */
export const librarySession = async (means: Partial<SessionMeans> = {}) => {
  const workspace = testWorkspace();
  const store = createArtifactStore(
    new ArtifactManager({ store: new InMemoryArtifactStore() })
  );
  const lato = await importOne(workspace, fixtureFile("lato"));
  const sofia = await importOne(workspace, fixtureFile("sofia"));
  const session = createReconstructSession({
    builder,
    clock: fixedClock,
    codec: nodeImageCodec,
    // An opened photograph and what a model returned for a completion are
    // kept, so a session is given a store.
    keepModelOutput: store.keepModelOutput,
    keepPhotograph: store.keepPhotograph,
    newId: countingIds("completion"),
    providerKey: () => "",
    runs: fetchedRuns("/", fixtureFetch),
    workspace,
    ...means,
  });
  return { lato, session, sofia, workspace };
};

/** A session with the storefront photograph open and its banner marked. */
export const bannerSession = async (means: Partial<SessionMeans> = {}) => {
  const made = await librarySession(means);
  await made.session.openEvidence(evidenceFile(STOREFRONT));
  made.session.markRegion(BANNER);
  await drawn();
  return made;
};

export const codeOf = (letter: string) => letter.codePointAt(0) ?? 0;

/** Waits for the region to be read after the screen has drawn. */
export const drawn = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
