import type { DatasetTransport } from "../dataset";
import { datasetReader } from "../dataset";
import { fileTransport } from "../dataset-files";
import { DATASET_FILES, lensFile } from "../dataset-layout";
import type { DatasetManifest } from "../semantics-types";
import { fileRolesLens } from "./file-roles";
import { frequentChangeLens } from "./frequent-change";
import type { Lens, LensId, LensReader, LensSettings } from "./lens-types";
import { nestingLens } from "./nesting";
import { packageSizesLens } from "./package-sizes";
import { placementLens } from "./placement";
import { proximityLens } from "./proximity";
import { responsibilityGroupsLens } from "./responsibility-groups";

// The lens phase of a scan. Every lens runs on every scan, after the
// dataset's files are written to the unpublished tree and before the
// manifest is, so that the published manifest names each lens's file.

/** Any lens, as the runner holds it; `derive`'s method syntax makes each lens assignable. */
export type AnyLens = Lens<LensId, unknown, keyof LensSettings>;

/** Every lens, in dependency order: a lens comes after the lenses it consumes. */
export const LENSES: readonly AnyLens[] = [
  fileRolesLens,
  frequentChangeLens,
  nestingLens,
  packageSizesLens,
  placementLens,
  proximityLens,
  responsibilityGroupsLens,
];

export interface WriteLensesOptions {
  /** The unpublished tree, holding every dataset file but the manifest. */
  dir: string;
  /** The manifest as it will be published, apart from its generation fields. */
  draft: DatasetManifest;
  /** The lenses to run, in order; every registered lens by default. */
  lenses?: readonly AnyLens[];
  settings: LensSettings;
  /** Writes one dataset file; called once per lens, in order, before the next lens runs. */
  write: (file: string, value: unknown) => void;
}

/**
 * Runs every lens over the unpublished dataset and writes its output. A lens
 * may read only the lenses it names in `consumes`, once they have run. A
 * lens that throws fails the scan.
 */
export async function writeLenses(options: WriteLensesOptions): Promise<void> {
  const reader = lensReader(options.dir, options.draft);
  const written = new Set<LensId>();
  const { lenses = LENSES } = options;
  for (const lens of lenses) {
    const output = lens.derive(
      await lens.read(scopedTo(lens, reader, written)),
      pickSettings(options.settings, lens.settings)
    );
    options.write(lensFile(lens.id), output);
    written.add(lens.id);
  }
}

/** The reader as one lens sees it: other lenses only as its `consumes` names them, once written. */
function scopedTo(
  lens: AnyLens,
  reader: LensReader,
  written: ReadonlySet<LensId>
): LensReader {
  return {
    ...reader,
    lens: (id) => {
      if (!(lens.consumes?.includes(id) && written.has(id))) {
        return Promise.reject(
          new Error(
            `The ${lens.id} lens reads the ${id} lens without naming it in consumes, or before the ${id} lens runs.`
          )
        );
      }
      return reader.lens(id);
    },
  };
}

/** The settings a lens names, and no others. */
function pickSettings<K extends keyof LensSettings>(
  settings: LensSettings,
  keys: readonly K[]
): Pick<LensSettings, K> {
  return Object.fromEntries(keys.map((key) => [key, settings[key]])) as Pick<
    LensSettings,
    K
  >;
}

/**
 * The unpublished dataset through the reader: the manifest from the draft,
 * every other file from `dir`. Each file is parsed once for the whole phase
 * and shared by every lens, except package reports, which are large: they
 * are read afresh for each request and kept by no one but the lens, which
 * keeps only the fields it needs. A lens's file is read only through its
 * consumer's scoped reader, once it has been written, so no miss of a lens
 * file is ever cached.
 */
function lensReader(dir: string, draft: DatasetManifest): LensReader {
  const files = fileTransport(dir);
  /** `read`, with the manifest answered by the draft. */
  const withDraft =
    (read: DatasetTransport): DatasetTransport =>
    (path) =>
      path === DATASET_FILES.manifest ? Promise.resolve(draft) : read(path);
  const parsed = new Map<string, Promise<unknown>>();
  const cached: DatasetTransport = (path) => {
    const kept = parsed.get(path);
    if (kept !== undefined) {
      return kept;
    }
    const read = files(path);
    parsed.set(path, read);
    return read;
  };
  const {
    history: _history,
    manifest: _manifest,
    ...reader
  } = datasetReader(withDraft(cached));
  const { packageReport } = datasetReader(withDraft(files));
  const packages = draft.packages.map((pkg) => ({
    id: pkg.id,
    internals: pkg.internals !== undefined,
    path: pkg.path,
    status: pkg.status,
  }));
  return { ...reader, packageReport, packages: () => packages };
}
