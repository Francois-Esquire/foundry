import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Fetch } from "~/generate/recorded-catalogue";
import { createGenerateSession, type SessionMeans } from "~/generate/session";
import { nodeImageCodec } from "../../../scripts/generation/node-image-codec";
import { fixtureFile, importOne, testWorkspace } from "../../helpers/workspace";

const RUNS = path.join(import.meta.dirname, "../../fixtures/generation");
const ROUTE = "/recorded-runs/";

/** Serves the recorded-run fixtures the way the app's server does, from disk. */
export const fixtureFetch: Fetch = (address) => {
  if (!address.startsWith(ROUTE)) {
    return Promise.resolve(new Response(null, { status: 404 }));
  }
  const name = address.slice(ROUTE.length);
  if (name === "index.json") {
    const directories = readdirSync(RUNS).filter((directory) =>
      existsSync(path.join(RUNS, directory, "run.json"))
    );
    return Promise.resolve(Response.json(directories));
  }
  const file = path.join(RUNS, name);
  return Promise.resolve(
    existsSync(file)
      ? new Response(new Uint8Array(readFileSync(file)))
      : new Response(null, { status: 404 })
  );
};

/** A session over a workspace that holds Lato, with the Node codec and the fixture runs. */
export const latoSession = async (means: Partial<SessionMeans> = {}) => {
  const workspace = testWorkspace();
  const { faceId } = await importOne(workspace, fixtureFile("lato"));
  let issued = 0;
  const session = createGenerateSession({
    base: "/",
    codec: nodeImageCodec,
    fetch: fixtureFetch,
    newId: () => {
      issued += 1;
      return `run-${issued}`;
    },
    workspace,
    ...means,
  });
  return { faceId, session, workspace };
};

export const codes = (text: string) =>
  [...text].map((character) => character.codePointAt(0) ?? 0);
