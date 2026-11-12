/**
 * The application as Node runs it: artifacts kept in a directory, the font
 * engine on Pyodide, HarfBuzz and the pure JavaScript image codec. Nothing
 * the browser loads may import this file.
 */
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ArtifactManager } from "@foundry/artifacts";
import { blobFiles, JsonArtifactStore } from "@foundry/artifacts/node";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { nodeImageCodec } from "~/generation/node-image-codec";
import {
  filesRun,
  type RecordedRunSource,
} from "~/generation/strategies/recorded/source";
import { Refusal } from "~/lib/refusal";
import type { FontBuilder } from "~/packaging/building";
import { nodeFontBuilder } from "~/packaging/engine/node";
import { type Application, openApplication } from "./application";
import { findProject } from "./artifact-store";

export interface NodeApplicationOptions {
  /** Says when something happened. The system clock when absent. */
  readonly clock?: () => Date;
  /** Where the project's artifacts are kept: `records.json` and `blobs/`. */
  readonly directory: string;
  /** Replaces the network for model calls in tests. */
  readonly modelFetch?: typeof fetch;
  /** Random ids when absent. */
  readonly newId?: () => string;
  /** The model provider's key. Without one no model is called. */
  readonly providerKey?: string;
}

const MANIFEST = "run.json";

/** The font engine, started by the first command that builds a font and by no other. */
const engine: FontBuilder = {
  blankFont: async (request) => (await nodeFontBuilder()).blankFont(request),
  build: async (request) => (await nodeFontBuilder()).build(request),
  buildVariable: async (request) =>
    (await nodeFontBuilder()).buildVariable(request),
  describeLayout: async (font, faceIndex) =>
    (await nodeFontBuilder()).describeLayout(font, faceIndex),
  validate: async (font) => (await nodeFontBuilder()).validate(font),
};

/** Node serves no recorded runs: a command is given the run it replays. */
const NO_SERVED_RUNS: RecordedRunSource = {
  file: (run, name) =>
    Promise.reject(
      new Refusal(`No recorded run is served here, so ${run}/${name} is not.`)
    ),
  list: () => Promise.resolve([]),
};

const SEPARATOR = /[\\/]+/;

/** The last part of a location: the name a recorded run's directory goes by. */
const runName = (location: string) =>
  location.split(SEPARATOR).filter(Boolean).at(-1) ?? location;

/**
 * A recorded run is a directory: `run.json` and the files it names. It goes
 * by the directory's name, and every file in it is read.
 */
const runAtDirectory = async (
  directory: string
): Promise<RecordedRunSource & { readonly name: string }> => {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => undefined
  );
  if (!entries) {
    throw new Refusal(
      `There is no recorded run at ${directory}. Give the directory that holds its run.json.`
    );
  }
  const files = new Map<string, Uint8Array>();
  for (const entry of entries) {
    if (entry.isFile()) {
      files.set(
        entry.name,
        new Uint8Array(await readFile(path.join(directory, entry.name)))
      );
    }
  }
  if (!files.has(MANIFEST)) {
    throw new Refusal(
      `${directory} has no run.json, so it is not a recorded run.`
    );
  }
  return filesRun(runName(directory), files);
};

/**
 * Opens the project a directory holds, or an empty one when it holds none
 * yet. A directory holds one project.
 */
export const openNodeApplication = async ({
  clock = () => new Date(),
  directory,
  modelFetch,
  newId = randomUUID,
  providerKey,
}: NodeApplicationOptions): Promise<Application> => {
  const artifacts = new ArtifactManager({
    files: blobFiles(path.join(directory, "blobs")),
    store: new JsonArtifactStore({
      path: path.join(directory, "records.json"),
    }),
  });
  return openApplication(
    {
      artifacts,
      builder: engine,
      clock,
      codec: nodeImageCodec,
      modelFetch,
      newId,
      providerKey,
      reader: harfBuzzReader,
      runAt: runAtDirectory,
      servedRuns: NO_SERVED_RUNS,
      // Steps are timed on the same clock, so a fixed clock times them all at nothing.
      timer: () => clock().getTime(),
    },
    await findProject(artifacts)
  );
};
