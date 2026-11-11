import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArtifactManager } from "@foundry/artifacts";
import { blobFiles, JsonArtifactStore } from "@foundry/artifacts/node";
import type { Application } from "~/application/application";
import {
  type NodeApplicationOptions,
  openNodeApplication,
} from "~/application/node";
import { countingIds } from "../../helpers/fixed";

export const FIXTURES = path.join(import.meta.dirname, "../../fixtures");
export const AT = "2026-11-10T12:00:00.000Z";

export const fixtureAt = (relative: string) => ({
  bytes: new Uint8Array(readFileSync(path.join(FIXTURES, relative))),
  name: path.basename(relative),
});

export const recordedRun = (name: string) =>
  path.join(FIXTURES, "generation", name);

/**
 * One project directory with one clock and one run of ids across every
 * reopening, as a person's project has between two command-line calls.
 */
export const tempProject = (
  options: Partial<Omit<NodeApplicationOptions, "directory">> = {}
) => {
  const directory = mkdtempSync(path.join(tmpdir(), "typography-app-"));
  const newId = countingIds();
  const open = () =>
    openNodeApplication({
      clock: () => new Date(AT),
      directory,
      newId,
      ...options,
    });
  return {
    /** The same artifacts the application keeps, read directly. */
    artifacts: () =>
      new ArtifactManager({
        files: blobFiles(path.join(directory, "blobs")),
        store: new JsonArtifactStore({
          path: path.join(directory, "records.json"),
        }),
      }),
    directory,
    open,
    remove: () => rmSync(directory, { force: true, recursive: true }),
    /** Saves, closes and opens again. */
    reopen: async (app: Application) => {
      await app.save();
      await app.close();
      return open();
    },
  };
};

/** A value a test cannot go on without. Throws when it is absent. */
export const found = <Value>(value: Value | null | undefined): Value => {
  if (value === null || value === undefined) {
    throw new Error("The test expected a value here and found none.");
  }
  return value;
};

/** Imports Lato and answers with its face. */
export const importLato = async (app: Application) => {
  const imported = await app.import([fixtureAt("fonts/Lato-Regular.ttf")]);
  const [font] = imported.fonts;
  const faceId = font?.faces[0]?.faceId;
  if (!(font && faceId)) {
    throw new Error("Lato was not imported.");
  }
  return { artifactId: font.artifactId, faceId };
};
