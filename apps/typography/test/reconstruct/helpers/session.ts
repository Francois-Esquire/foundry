import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { nodeImageCodec } from "~/generation/node-image-codec";
import { nodeFontBuilder } from "~/packaging/engine/node";
import { rectangle } from "~/reconstruct/core";
import type { Fetch } from "~/reconstruct/samples";
import {
  createReconstructSession,
  type SessionMeans,
} from "~/reconstruct/session";
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
 * A session over a workspace that holds Lato and Sofia Sans, reading at once
 * instead of after the screen has drawn.
 */
export const librarySession = async (means: Partial<SessionMeans> = {}) => {
  const workspace = testWorkspace();
  const lato = await importOne(workspace, fixtureFile("lato"));
  const sofia = await importOne(workspace, fixtureFile("sofia"));
  const session = createReconstructSession({
    base: "/",
    builder,
    codec: nodeImageCodec,
    defer: (work) => work(),
    fetch: fixtureFetch,
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
  return made;
};

export const codeOf = (letter: string) => letter.codePointAt(0) ?? 0;
