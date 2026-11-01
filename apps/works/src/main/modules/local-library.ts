import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { blobFiles, JsonArtifactStore } from "@foundry/artifacts/node";
import {
  hasErrorCode,
  readJsonFile,
  writeFileAtomic,
} from "@foundry/lib/atomic-file";
import { isPortableRelativePath } from "@foundry/modules/manifest";
import { captureModuleWorkspaceSource } from "@foundry/modules/node/source";
import { KeyedTurns } from "@foundry/modules/platform/turns";
import { z } from "zod";
import {
  SourceEvidenceRequired,
  type SourceSaves,
} from "~/main/execution/source-evidence";
import type { ModuleDetails, ModuleSourceRevision } from "~/shared/modules";
import { modulePersistence } from "./artifact-store";
import {
  type ModuleLibrary,
  type ModuleRecords,
  savingLibrary,
} from "./library";
import { admitSource } from "./source-admission";

const markerSchema = z.object({
  binding: z
    .object({
      artifactId: z.string(),
      contentId: z.string(),
      updatedAt: z.iso.datetime(),
    })
    .nullable(),
  digest: z.string().length(64),
  /**
   * Absent on folders written before `source/` existed: their source sits
   * at the Module folder root until it is relocated once.
   */
  layout: z.enum(["relocating", "source"]).optional(),
  paths: z.array(z.string()),
});
type Marker = z.infer<typeof markerSchema>;

/** Where relocation gathers a legacy folder's entries before naming them `source/`. */
const RELOCATING = ".relocating-source";

const DIRECTORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
export function moduleDirectory(id: string) {
  if (DIRECTORY_ID.test(id)) {
    return id;
  }
  return createHash("sha256").update(id).digest("hex").slice(0, 24);
}

/** The installed folder of one Module and its three top-level directories. */
export interface ModuleFolder {
  /** The selected release's built output, read-only. */
  readonly artifact: string;
  /** `data.sqlite` and its companions: the only read-write app mount. */
  readonly data: string;
  readonly root: string;
  /** Everything buildable, `foundry.module.json` included. */
  readonly source: string;
}

export function moduleFolder(root: string, id: string): ModuleFolder {
  const folder = path.join(root, moduleDirectory(id));
  return {
    artifact: path.join(folder, "artifact"),
    data: path.join(folder, "data"),
    root: folder,
    source: path.join(folder, "source"),
  };
}

export interface ModuleStoreOptions {
  /** The Works profile whose earlier `modules/artifacts.json` is copied in once. */
  readonly legacyUserData?: string;
  /** The shared manager's per-file rejection limit; the manager default when absent. */
  readonly maxFileBytes?: number;
}

export interface LocalModuleLibraryOptions {
  /** The Module records, over the store {@link openModuleStore} opened. */
  readonly records: ModuleRecords;
  /** How source saves and releases run, are admitted and are recorded. */
  readonly saves: SourceSaves;
}

function digest(source: Record<string, string>) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        Object.keys(source)
          .sort()
          .map((file) => [file, source[file]])
      )
    )
    .digest("hex");
}
async function exists(file: string) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

/**
 * The Module library's records store, `.library/artifacts.json` under
 * `root`, with its one shared manager composed: new file bytes are backing
 * files under `.library/blobs`, and backing files a crashed write left
 * behind are removed.
 */
export async function openModuleStore(
  root: string,
  options: ModuleStoreOptions = {}
): Promise<JsonArtifactStore> {
  const { legacyUserData } = options;
  const privateRoot = path.join(root, ".library");
  await mkdir(privateRoot, { mode: 0o700, recursive: true });
  const artifactFile = path.join(privateRoot, "artifacts.json");
  if (legacyUserData && !(await exists(artifactFile))) {
    const legacy = path.join(legacyUserData, "modules", "artifacts.json");
    if (await exists(legacy)) {
      await copyFile(legacy, artifactFile, constants.COPYFILE_EXCL);
    }
  }
  const store = new JsonArtifactStore({ path: artifactFile });
  // Composed before anything asks for it, so every caller of this store
  // shares the one file-backed manager.
  const { artifacts } = modulePersistence(store, {
    files: blobFiles(path.join(privateRoot, "blobs")),
    ...(options.maxFileBytes === undefined
      ? {}
      : { maxFileBytes: options.maxFileBytes }),
  });
  // Backing files a crashed write left behind, with no record naming them.
  await artifacts.recover();
  return store;
}

/**
 * Editable working folders and immutable Artifact releases share one
 * library. Records stay in the store {@link openModuleStore} opened, and
 * each Module's buildable source is materialized in its folder's
 * `source/`. Saves, releases and disk edits commit in the Module's turn,
 * between two synchronizations of its folder.
 */
export async function openLocalModuleLibrary(
  root: string,
  options: LocalModuleLibraryOptions
): Promise<ModuleLibrary> {
  const { records: core, saves } = options;
  const privateRoot = path.join(root, ".library");
  const turns = new KeyedTurns<string>();
  const staging = path.join(privateRoot, "staging");
  const markers = path.join(privateRoot, "workspaces");
  await mkdir(staging, { mode: 0o700, recursive: true });
  await mkdir(markers, { mode: 0o700, recursive: true });

  const markerFile = (id: string) =>
    path.join(markers, `${moduleDirectory(id)}.json`);
  async function readMarker(id: string): Promise<Marker | null> {
    const marker = await readJsonFile(markerFile(id));
    return marker === undefined ? null : markerSchema.parse(marker);
  }
  async function writeMarker(id: string, marker: Marker) {
    await writeFileAtomic(markerFile(id), JSON.stringify(marker), {
      mode: 0o600,
    });
  }
  async function record(details: ModuleDetails) {
    await writeMarker(details.id, {
      binding: details.binding,
      digest: digest(details.source),
      layout: "source",
      paths: Object.keys(details.source),
    });
  }
  /**
   * Moves a folder written before `source/` existed into its `source/`,
   * once. Every entry moves by rename, so files (pending disk edits
   * included) are never copied or rewritten, and an interrupted move
   * resumes: the gathering directory exists before the marker says
   * `relocating`, and disappears only by becoming `source/`.
   */
  async function relocate(id: string) {
    const marker = await readMarker(id);
    const folder = moduleFolder(root, id);
    if (
      marker === null ||
      marker.layout === "source" ||
      !(await exists(folder.root))
    ) {
      return;
    }
    const holding = path.join(folder.root, RELOCATING);
    if (marker.layout === undefined || (await exists(holding))) {
      await mkdir(holding, { mode: 0o700, recursive: true });
      if (marker.layout === undefined) {
        await writeMarker(id, { ...marker, layout: "relocating" });
      }
      for (const name of await readdir(folder.root)) {
        if (name !== RELOCATING) {
          await rename(path.join(folder.root, name), path.join(holding, name));
        }
      }
      await rename(holding, folder.source);
    }
    await writeMarker(id, { ...marker, layout: "source" });
  }
  /** Files at the folder root with no marker were never written by Works. */
  async function refuseUnregistered(id: string) {
    if (
      (await readMarker(id)) === null &&
      (await occupied(moduleFolder(root, id)))
    ) {
      throw new Error(
        "An unregistered workspace occupies this module folder. Its files were preserved."
      );
    }
  }
  async function materialize(details: ModuleDetails) {
    if (!details.binding) {
      return;
    }
    const folder = moduleFolder(root, details.id);
    const destination = folder.source;
    const next = path.join(staging, randomUUID());
    const previous = path.join(staging, randomUUID());
    await mkdir(folder.root, { mode: 0o700, recursive: true });
    await mkdir(next, { mode: 0o700 });
    const marker = await readMarker(details.id);
    try {
      if (await exists(destination)) {
        await cp(destination, next, { dereference: false, recursive: true });
      }
      await writeWorkspaceSource(next, details.source, marker?.paths ?? []);
      const hadPrevious = await exists(destination);
      if (hadPrevious) {
        await rename(destination, previous);
      }
      try {
        await rename(next, destination);
      } catch (error) {
        if (hadPrevious) {
          await rename(previous, destination);
        }
        throw error;
      }
      await record(details);
      await rm(previous, { force: true, recursive: true });
    } finally {
      await rm(next, { force: true, recursive: true });
    }
  }
  async function synchronize(id: string): Promise<ModuleDetails | null> {
    const details = await core.details(id);
    if (!details?.binding) {
      return details;
    }
    await relocate(id);
    const folder = moduleFolder(root, id);
    const directory = folder.source;
    if (!(await exists(directory))) {
      await refuseUnregistered(id);
      await materialize(details);
      return details;
    }
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Module workspace must be a real directory");
    }
    const source = { ...(await captureModuleWorkspaceSource(directory)) };
    const currentDigest = digest(source);
    const artifactDigest = digest(details.source);
    if (currentDigest === artifactDigest) {
      await record(details);
      return details;
    }
    const marker = await readMarker(id);
    if (!marker) {
      throw new Error(
        "An unregistered workspace occupies this module folder. Its files were preserved."
      );
    }
    if (JSON.stringify(marker.binding) !== JSON.stringify(details.binding)) {
      if (currentDigest !== marker.digest) {
        throw new Error(
          "Module files and saved source both changed. Your local files were preserved; resolve the conflict before continuing."
        );
      }
      await materialize(details);
      return details;
    }
    return await saveDiskEdits(id, source, details.binding, details);
  }
  /** Disk edits, admitted like any other source, saved on the binding they were made on. */
  async function saveDiskEdits(
    id: string,
    source: Record<string, string>,
    binding: ModuleSourceRevision,
    details: ModuleDetails
  ): Promise<ModuleDetails> {
    admitSource(source);
    try {
      await saves.admit(id);
    } catch (error) {
      if (!(error instanceof SourceEvidenceRequired)) {
        throw error;
      }
      // Refused for now: the edits stay on disk for the next sync.
      return details;
    }
    await saves.run(
      { actor: "disk", kind: "source", moduleId: id },
      async (origin) => {
        const saved = await core.writeSource(id, source, binding, origin);
        return { saved, value: saved };
      }
    );
    const updated = await core.details(id);
    if (!updated) {
      throw new Error("Module disappeared while saving local source");
    }
    await record(updated);
    return updated;
  }
  const library: ModuleLibrary = {
    ...savingLibrary(core, saves, (id, commit) =>
      turns.run(id, async () => {
        await synchronize(id);
        const committed = await commit();
        await synchronize(id);
        return committed;
      })
    ),
    async create(name) {
      const module = await core.create(name);
      await turns.run(module.id, () => synchronize(module.id));
      return module;
    },
    details: (id) => turns.run(id, () => synchronize(id)),
    async importPackage(encoded) {
      const module = await core.importPackage(encoded);
      await turns.run(module.id, () => synchronize(module.id));
      return module;
    },
  };
  for (const module of await core.list()) {
    await library.details(module.id);
  }
  return library;
}

/** Anything in the folder besides the release output and private data. */
async function occupied(folder: ModuleFolder): Promise<boolean> {
  if (!(await exists(folder.root))) {
    return false;
  }
  const kept = new Set([
    path.basename(folder.artifact),
    path.basename(folder.data),
  ]);
  return (await readdir(folder.root)).some((name) => !kept.has(name));
}

async function assertWritableSource(root: string, file: string) {
  const segments = file.split("/");
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    if ((await exists(current)) && (await lstat(current)).isSymbolicLink()) {
      throw new Error(
        "Module source cannot be written through a symbolic link"
      );
    }
  }
}

async function writeWorkspaceSource(
  root: string,
  source: Record<string, string>,
  previousPaths: string[]
) {
  for (const file of previousPaths) {
    if (!isPortableRelativePath(file)) {
      throw new Error("Invalid workspace marker path");
    }
    if (!Object.hasOwn(source, file)) {
      await assertWritableSource(root, file);
      await rm(path.join(root, file), { force: true });
    }
  }
  for (const [file, text] of Object.entries(source)) {
    if (!isPortableRelativePath(file)) {
      throw new Error("Invalid module source path");
    }
    const target = path.join(root, file);
    await assertWritableSource(root, file);
    await mkdir(path.dirname(target), { mode: 0o700, recursive: true });
    await writeFile(target, text, { mode: 0o600 });
  }
}
