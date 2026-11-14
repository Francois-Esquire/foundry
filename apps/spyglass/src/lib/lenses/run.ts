import type { DatasetTransport } from "../dataset";
import { datasetReader } from "../dataset";
import { DATASET_FILES, lensFile } from "../dataset-layout";
import type { DatasetManifest } from "../semantics-types";
import { domainsLens } from "./domains";
import { fileRolesLens } from "./file-roles";
import { frequentChangeLens } from "./frequent-change";
import { importTrafficLens } from "./import-traffic";
import type { Lens, LensId, LensReader, LensSettings } from "./lens-types";
import { nestingLens } from "./nesting";
import { packageSizesLens } from "./package-sizes";
import { placementLens } from "./placement";
import { proximityLens } from "./proximity";
import { responsibilityGroupsLens } from "./responsibility-groups";
import { rulesLens } from "./rules";

export type AnyLens = Lens<LensId, unknown, keyof LensSettings>;

export const LENSES: readonly AnyLens[] = [
  fileRolesLens,
  frequentChangeLens,
  importTrafficLens,
  nestingLens,
  packageSizesLens,
  placementLens,
  proximityLens,
  responsibilityGroupsLens,
  domainsLens,
  rulesLens,
];

export interface WriteLensesOptions {
  draft: DatasetManifest;

  lenses?: readonly AnyLens[];

  read: DatasetTransport;
  settings: LensSettings;

  write: (file: string, value: unknown) => void;
}

export async function writeLenses(options: WriteLensesOptions): Promise<void> {
  const reader = lensReader(options.read, options.draft);
  const written = new Set<LensId>();
  const { lenses = LENSES } = options;
  for (const lens of lenses) {
    const settings = pickSettings(options.settings, lens.settings);
    const output = lens.derive(
      await lens.read(scopedTo(lens, reader, written), settings),
      settings
    );
    options.write(lensFile(lens.id), output);
    written.add(lens.id);
  }
}

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

function pickSettings<K extends keyof LensSettings>(
  settings: LensSettings,
  keys: readonly K[]
): Pick<LensSettings, K> {
  return Object.fromEntries(keys.map((key) => [key, settings[key]])) as Pick<
    LensSettings,
    K
  >;
}

function lensReader(
  files: DatasetTransport,
  draft: DatasetManifest
): LensReader {
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
