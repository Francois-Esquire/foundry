import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { Artifacts } from "@foundry/artifacts";
import {
  type ContentProjection,
  projectionMatches,
  stageProjection,
} from "@foundry/artifacts/node";
import { hasErrorCode } from "@foundry/lib/atomic-file";
import type { ModuleVersion } from "@foundry/modules/domain";
import type { ModuleCheckouts } from "@foundry/modules/platform/files";
import { KeyedTurns } from "@foundry/modules/platform/turns";
import { type ModuleFolder, moduleFolder } from "../local-library";
import { ModuleRuntimeError } from "./controller";

/** Staged and set-aside copies of `artifact/` sit beside it under this prefix. */
const SCRATCH_PREFIX = ".artifact-";

type SelectedVersion = Pick<ModuleVersion, "contentId" | "digest" | "moduleId">;

/**
 * Each Module's `artifact/`: the selected release's built output, projected
 * read-only from its frozen Content. Older releases stay in Artifact
 * storage, so any of them can be projected again. The Installation's
 * selection is authoritative: whenever `artifact/` does not match it (an
 * interrupted switch, or files changed on disk) it is projected again
 * before a Program starts.
 */
export interface ModuleReleaseFiles extends ModuleCheckouts {
  /**
   * Stages and verifies `version`'s outputs, swaps them in as `artifact/`,
   * then runs `record` to select the Version. If `record` fails, the
   * previous files are put back, so the previous selection keeps its files.
   */
  select<T>(
    version: SelectedVersion,
    record: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T>;
}

export function createModuleReleaseFiles(options: {
  readonly artifacts: Pick<Artifacts, "getContent" | "readFileRange">;
  /** The Modules root holding each Module's folder. */
  readonly root: string;
}): ModuleReleaseFiles {
  const turns = new KeyedTurns<string>();

  function projection(version: SelectedVersion): ContentProjection {
    return {
      artifacts: options.artifacts,
      contentId: version.contentId,
      include: (file) => file === "outputs" || file.startsWith("outputs/"),
    };
  }
  async function frozen(version: SelectedVersion) {
    const content = await options.artifacts.getContent(version.contentId);
    if (content?.state !== "frozen" || content.digest !== version.digest) {
      throw new ModuleRuntimeError(
        "This release's stored files do not match its Version"
      );
    }
  }
  /** What an interrupted stage or swap left beside `artifact/`. */
  async function sweep(folder: ModuleFolder) {
    const names = await readdir(folder.root).catch((error: unknown) => {
      missing(error);
      return [];
    });
    for (const name of names) {
      if (name.startsWith(SCRATCH_PREFIX)) {
        await rm(path.join(folder.root, name), {
          force: true,
          recursive: true,
        });
      }
    }
  }
  async function stage(
    version: SelectedVersion,
    folder: ModuleFolder,
    signal?: AbortSignal
  ) {
    await frozen(version);
    await mkdir(folder.root, { mode: 0o700, recursive: true });
    await sweep(folder);
    const staged = path.join(folder.root, `${SCRATCH_PREFIX}${randomUUID()}`);
    try {
      await stageProjection(projection(version), staged, signal);
    } catch (error) {
      await rm(staged, { force: true, recursive: true });
      throw error;
    }
    return staged;
  }
  /** `staged` becomes `artifact/`; returns where the previous files went. */
  async function swap(staged: string, folder: ModuleFolder) {
    const aside = (await exists(folder.artifact))
      ? path.join(folder.root, `${SCRATCH_PREFIX}${randomUUID()}`)
      : null;
    if (aside) {
      await rename(folder.artifact, aside);
    }
    try {
      await rename(staged, folder.artifact);
    } catch (error) {
      if (aside) {
        await rename(aside, folder.artifact);
      }
      throw error;
    }
    return aside;
  }

  return {
    ensure: ({ version, signal }) =>
      turns.run(version.moduleId, async () => {
        const folder = moduleFolder(options.root, version.moduleId);
        await frozen(version);
        await sweep(folder);
        if (!(await projectionMatches(projection(version), folder.artifact))) {
          const aside = await swap(
            await stage(version, folder, signal),
            folder
          );
          if (aside) {
            await rm(aside, { force: true, recursive: true });
          }
        }
        return { hostPath: folder.artifact };
      }),
    select: (version, record, signal) =>
      turns.run(version.moduleId, async () => {
        const folder = moduleFolder(options.root, version.moduleId);
        const aside = await swap(await stage(version, folder, signal), folder);
        let recorded: Awaited<ReturnType<typeof record>>;
        try {
          recorded = await record();
        } catch (error) {
          await rm(folder.artifact, { force: true, recursive: true });
          if (aside) {
            await rename(aside, folder.artifact);
          }
          throw error;
        }
        if (aside) {
          await rm(aside, { force: true, recursive: true });
        }
        return recorded;
      }),
  };
}

async function exists(target: string) {
  return (await lstat(target).catch(missing)) !== undefined;
}

function missing(error: unknown): undefined {
  if (!hasErrorCode(error, "ENOENT")) {
    throw error;
  }
}
