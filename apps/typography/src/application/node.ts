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
import type { FontBuilder } from "~/packaging/building";
import { nodeFontBuilder } from "~/packaging/engine/node";
import { type Application, openApplication } from "./application";
import { Refusal } from "./refusal";
import { NO_RECORDED_RUNS } from "./served-run";
import { findProject } from "./store";

export interface NodeApplicationOptions {
  /** Where the project's artifacts are kept: `records.json` and `blobs/`. */
  readonly directory: string;
  /** Replaces the network for model calls in tests. */
  readonly modelFetch?: typeof fetch;
  /** Random ids when absent. */
  readonly newId?: () => string;
  /** The system clock when absent. */
  readonly now?: () => string;
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

/** A recorded run is a directory: `run.json` and the files it names. */
const readRunDirectory = async (
  directory: string
): Promise<ReadonlyMap<string, Uint8Array>> => {
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
  return files;
};

/**
 * Opens the project a directory holds, or an empty one when it holds none
 * yet. A directory holds one project.
 */
export const openNodeApplication = async ({
  directory,
  modelFetch,
  newId = randomUUID,
  now = () => new Date().toISOString(),
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
      codec: nodeImageCodec,
      modelFetch,
      newId,
      now,
      providerKey,
      reader: harfBuzzReader,
      readRecordedRun: readRunDirectory,
      // Node serves no recorded runs: a command reads the run it is given.
      servedRuns: NO_RECORDED_RUNS,
      // Steps are timed on the same clock, so a fixed clock times them all at nothing.
      timer: () => Date.parse(now()),
    },
    await findProject(artifacts)
  );
};
