/**
 * What a source of recorded runs holds, and loading one of them for replay.
 * Every output of every run is one entry a person, or a command, can choose.
 */
import {
  loadRecordedRuns,
  outputLabel,
  parseManifest,
  type RecordedOutput,
  type RecordedRun,
  RecordedRunError,
  type RecordedRunManifest,
} from "./manifest";
import type { RecordedRunSource } from "./source";

/** One output of one recorded run. */
export interface RecordedEntry {
  /** The name the source holds the run under. */
  readonly directory: string;
  /** The photograph the model was shown, by file name, when the run was made to complete a reconstruction. */
  readonly evidenceFile?: string;
  /** Unique among the entries: the run's name and the output's label. */
  readonly id: string;
  /** The face the models were shown, when the run was made from a font. */
  readonly madeFrom?: { readonly family: string; readonly style?: string };
  readonly manifest: RecordedRunManifest;
  /** The manifest exactly as the source holds it, for loading. */
  readonly manifestText: string;
  readonly output: RecordedOutput;
  /** What the run was for, in the words of whoever recorded it. */
  readonly purpose?: string;
  /** The characters the model drew, in the order of its sheet. */
  readonly targets: readonly string[];
}

export interface RecordedCatalogue {
  readonly entries: readonly RecordedEntry[];
  /** Runs that are listed but could not be read, each with the reason. */
  readonly problems: readonly string[];
}

/** A source's catalogue as a screen holds it. A failed listing can be asked for again. */
export type CatalogueState =
  | { readonly status: "idle" | "loading" }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "listed"; readonly catalogue: RecordedCatalogue };

const MANIFEST = "run.json";

const entriesOf = (
  directory: string,
  manifestText: string
): RecordedEntry[] => {
  const manifest = parseManifest(manifestText);
  const { purpose, sourceFont } = manifest;
  const madeFrom = sourceFont?.family
    ? { family: sourceFont.family, style: sourceFont.style }
    : undefined;
  return manifest.outputs.map((output) => ({
    directory,
    evidenceFile: manifest.evidence?.file,
    id: `${directory}#${outputLabel(output)}`,
    madeFrom,
    manifest,
    manifestText,
    output,
    purpose,
    targets: output.requested ?? manifest.targets ?? [],
  }));
};

/**
 * Lists every run a source holds. A run whose manifest cannot be read is
 * reported and left out; the others are still listed.
 */
export const listRecorded = async (
  source: RecordedRunSource
): Promise<RecordedCatalogue> => {
  const entries: RecordedEntry[] = [];
  const problems: string[] = [];
  for (const directory of await source.list()) {
    try {
      const manifest = await source.file(directory, MANIFEST);
      entries.push(...entriesOf(directory, new TextDecoder().decode(manifest)));
    } catch (error) {
      if (!(error instanceof RecordedRunError)) {
        throw error;
      }
      problems.push(`${directory}: ${error.message}`);
    }
  }
  return { entries, problems };
};

/** The files a replay of one entry reads: every sheet the manifest names, this output's prompt, and the reference. */
const filesFor = ({ manifest, output }: RecordedEntry): string[] => [
  ...new Set(
    [
      ...manifest.outputs.map((other) => other.file),
      output.promptFile,
      manifest.reference?.vector,
    ].filter((name) => name !== undefined)
  ),
];

/**
 * Every file of the run an entry belongs to: the manifest and each file it
 * names, byte for byte. This is what is kept of a replayed run, and it is
 * the same whichever output was replayed and wherever the run was read
 * from: a source hands over the files it is asked for by name, so a file
 * the manifest does not name is not part of the run.
 */
export const recordedFiles = async (
  source: RecordedRunSource,
  { directory, manifest }: RecordedEntry
): Promise<ReadonlyMap<string, Uint8Array>> => {
  const names = new Set(
    [
      MANIFEST,
      ...manifest.outputs.flatMap((output) => [output.file, output.promptFile]),
      manifest.reference?.file,
      manifest.reference?.vector,
    ].filter((name) => name !== undefined)
  );
  const files = new Map<string, Uint8Array>();
  for (const name of names) {
    files.set(name, await source.file(directory, name));
  }
  return files;
};

/** Reads an entry's raw files from its source and loads it for replay. */
export const loadRecorded = async (
  source: RecordedRunSource,
  entry: RecordedEntry
): Promise<RecordedRun> => {
  const files = new Map<string, Uint8Array>();
  for (const name of filesFor(entry)) {
    files.set(name, await source.file(entry.directory, name));
  }
  const run = loadRecordedRuns(entry.manifestText, files).find(
    (loaded) => outputLabel(loaded.output) === outputLabel(entry.output)
  );
  if (!run) {
    throw new RecordedRunError(
      `The recorded run ${entry.id} is no longer in its manifest.`
    );
  }
  return run;
};
