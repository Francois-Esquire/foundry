/**
 * The recorded runs served with the app: what each one holds, and loading
 * one for replay. Every output of every run is one entry a person can choose.
 */
import {
  loadRecordedRuns,
  outputLabel,
  parseManifest,
  type RecordedOutput,
  type RecordedRun,
  RecordedRunError,
  type RecordedRunManifest,
} from "~/generation/strategies/recorded/manifest";

/** Fetches one address. The browser's own fetch in the app, a file reader in tests. */
export type Fetch = (address: string) => Promise<Response>;

/** One output of one recorded run. */
export interface RecordedEntry {
  /** The directory the run's files are served from. */
  readonly directory: string;
  /** Unique among the entries: the directory and the output's label. */
  readonly id: string;
  /** The face the models were shown, when the run was made from a font. */
  readonly madeFrom?: { readonly family: string; readonly style?: string };
  readonly manifest: RecordedRunManifest;
  /** The manifest exactly as served, for loading. */
  readonly manifestText: string;
  readonly output: RecordedOutput;
  /** What the run was for, in the words of whoever recorded it. */
  readonly purpose?: string;
}

export interface RecordedCatalogue {
  readonly entries: readonly RecordedEntry[];
  /** Runs that are listed but could not be read, each with the reason. */
  readonly problems: readonly string[];
}

const ROUTE = "recorded-runs";

const fetchOk = async (fetcher: Fetch, address: string): Promise<Response> => {
  const response = await fetcher(address);
  if (!response.ok) {
    throw new RecordedRunError(
      `${address} could not be fetched (${response.status}).`
    );
  }
  return response;
};

const entriesOf = (directory: string, manifestText: string) => {
  const manifest = parseManifest(manifestText);
  const { purpose, sourceFont } = manifest;
  const madeFrom = sourceFont?.family
    ? { family: sourceFont.family, style: sourceFont.style }
    : undefined;
  return manifest.outputs.map(
    (output): RecordedEntry => ({
      directory,
      id: `${directory}#${outputLabel(output)}`,
      madeFrom,
      manifest,
      manifestText,
      output,
      purpose,
    })
  );
};

/**
 * Lists every recorded run under `base`. A run whose manifest cannot be read
 * is reported and left out; the others are still listed.
 */
export const listRecordedRuns = async (
  fetcher: Fetch,
  base: string
): Promise<RecordedCatalogue> => {
  const index: unknown = await (
    await fetchOk(fetcher, `${base}${ROUTE}/index.json`)
  ).json();
  const directories = Array.isArray(index)
    ? index.filter((item): item is string => typeof item === "string")
    : [];
  const entries: RecordedEntry[] = [];
  const problems: string[] = [];
  for (const directory of directories) {
    try {
      const manifest = await fetchOk(
        fetcher,
        `${base}${ROUTE}/${directory}/run.json`
      );
      entries.push(...entriesOf(directory, await manifest.text()));
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

/** Fetches an entry's raw files and loads it for replay. */
export const loadRecordedEntry = async (
  fetcher: Fetch,
  base: string,
  entry: RecordedEntry
): Promise<RecordedRun> => {
  const files = new Map<string, Uint8Array>();
  for (const name of filesFor(entry)) {
    const response = await fetchOk(
      fetcher,
      `${base}${ROUTE}/${entry.directory}/${name}`
    );
    files.set(name, new Uint8Array(await response.arrayBuffer()));
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

/** How an entry reads in a list: the run, which output, and the model that made it. */
export const entryLabel = ({ manifest, output }: RecordedEntry) =>
  `${manifest.id}, ${outputLabel(output)}: ${output.synthetic ? "synthetic sheet, no model" : output.model}`;

/**
 * Why a recorded run's glyphs are not compared with a face's own, when they
 * are not. The face's glyph is the answer only to a run made from that face.
 */
export const comparisonNote = (
  { madeFrom }: RecordedEntry,
  face: { readonly familyName: string; readonly fullName: string }
): string | undefined => {
  if (!madeFrom) {
    return "This run was not made from a font, so its glyphs are not compared with this face's own.";
  }
  if (madeFrom.family === face.familyName) {
    return;
  }
  const source = [madeFrom.family, madeFrom.style].filter(Boolean).join(" ");
  return `This run was made from ${source}, not from ${face.fullName}. Its glyphs were drawn to match that face and are not compared with this one's own.`;
};
