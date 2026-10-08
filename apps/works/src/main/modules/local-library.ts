import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { JsonArtifactStore } from "@foundry/artifacts/node";
import { isPortableRelativePath } from "@foundry/modules/manifest";
import { captureModuleWorkspaceSource } from "@foundry/modules/node/source";
import { KeyedTurns } from "@foundry/modules/platform/turns";
import { z } from "zod";
import type { ModuleDetails } from "~/shared/modules";
import { createModuleLibrary, type ModuleLibrary } from "./library";

const markerSchema = z.object({
  binding: z
    .object({
      artifactId: z.string(),
      contentId: z.string(),
      updatedAt: z.iso.datetime(),
    })
    .nullable(),
  digest: z.string().length(64),
  paths: z.array(z.string()),
});

const DIRECTORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
export function moduleDirectory(id: string) {
  if (DIRECTORY_ID.test(id)) {
    return id;
  }
  return createHash("sha256").update(id).digest("hex").slice(0, 24);
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
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/** Editable working folders and immutable Artifact releases share one library. */
export async function openLocalModuleLibrary(
  root: string,
  legacyUserData?: string
): Promise<{ library: ModuleLibrary; store: JsonArtifactStore }> {
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
  const core = createModuleLibrary(store);
  const turns = new KeyedTurns<string>();
  const staging = path.join(privateRoot, "staging");
  const markers = path.join(privateRoot, "workspaces");
  await mkdir(staging, { mode: 0o700, recursive: true });
  await mkdir(markers, { mode: 0o700, recursive: true });

  async function record(details: ModuleDetails) {
    const file = path.join(markers, `${moduleDirectory(details.id)}.json`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        JSON.stringify({
          binding: details.binding,
          digest: digest(details.source),
          paths: Object.keys(details.source),
        }),
        { mode: 0o600 }
      );
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async function materialize(details: ModuleDetails) {
    if (!details.binding) {
      return;
    }
    const destination = path.join(root, moduleDirectory(details.id));
    const next = path.join(staging, randomUUID());
    const previous = path.join(staging, randomUUID());
    await mkdir(next, { mode: 0o700 });
    const markerFile = path.join(
      markers,
      `${moduleDirectory(details.id)}.json`
    );
    const marker = (await exists(markerFile))
      ? markerSchema.parse(JSON.parse(await readFile(markerFile, "utf8")))
      : null;
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
    const directory = path.join(root, moduleDirectory(id));
    if (!(await exists(directory))) {
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
    const markerFile = path.join(markers, `${moduleDirectory(id)}.json`);
    if (!(await exists(markerFile))) {
      throw new Error(
        "An unregistered workspace occupies this module folder. Its files were preserved."
      );
    }
    const marker = markerSchema.parse(
      JSON.parse(await readFile(markerFile, "utf8"))
    );
    if (JSON.stringify(marker.binding) !== JSON.stringify(details.binding)) {
      if (currentDigest !== marker.digest) {
        throw new Error(
          "Module files and saved source both changed. Your local files were preserved; resolve the conflict before continuing."
        );
      }
      await materialize(details);
      return details;
    }
    await core.saveSource(id, source, details.binding);
    const updated = await core.details(id);
    if (!updated) {
      throw new Error("Module disappeared while saving local source");
    }
    await record(updated);
    return updated;
  }
  const library: ModuleLibrary = {
    ...core,
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
    publish: (id, expected, input) =>
      turns.run(id, async () => {
        await synchronize(id);
        const published = await core.publish(id, expected, input);
        await synchronize(id);
        return published;
      }),
    saveSource: (id, source, expected) =>
      turns.run(id, async () => {
        await synchronize(id);
        const binding = await core.saveSource(id, source, expected);
        await synchronize(id);
        return binding;
      }),
  };
  for (const module of await core.list()) {
    await library.details(module.id);
  }
  return { library, store };
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
