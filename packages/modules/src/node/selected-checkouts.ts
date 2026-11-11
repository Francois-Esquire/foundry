import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import type { Artifacts } from "@foundry/artifacts";
import {
  type ContentProjection,
  projectionMatches,
  stageProjection,
} from "@foundry/artifacts/node";

import type { ModuleVersion } from "../domain";
import type { ModuleSelectedCheckouts } from "../platform/files";
import { KeyedTurns } from "../platform/turns";
import { ModuleCheckoutError } from "./checkouts";

type SelectedVersion = Pick<ModuleVersion, "contentId" | "digest" | "moduleId">;

export interface CreateModuleSelectedCheckoutsOptions {
  readonly artifacts: Pick<Artifacts, "getContent" | "readFileRange">;
  /**
   * Where a Module's checkout lives. Staged and set-aside copies sit beside
   * it, named after it with a leading dot, so its parent belongs to it.
   */
  readonly checkoutPath: (moduleId: string) => string;
}

/**
 * Each Module's selected checkout: the selected Version's `outputs/`,
 * projected read-only from its frozen Content. Earlier Versions stay in
 * Artifact storage, so any of them can be projected again.
 */
export function createModuleSelectedCheckouts(
  options: CreateModuleSelectedCheckoutsOptions
): ModuleSelectedCheckouts {
  const turns = new KeyedTurns<string>();

  function locate(moduleId: string) {
    const checkout = options.checkoutPath(moduleId);
    const parent = path.dirname(checkout);
    return {
      checkout,
      parent,
      scratch: () =>
        path.join(parent, `.${path.basename(checkout)}-${randomUUID()}`),
      scratchPrefix: `.${path.basename(checkout)}-`,
    };
  }
  type Location = ReturnType<typeof locate>;

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
      throw new ModuleCheckoutError(
        `Content ${version.contentId} does not match the selected version`
      );
    }
  }
  /** What an interrupted stage or swap left beside the checkout. */
  async function sweep(location: Location) {
    const names = await readdir(location.parent).catch(missing);
    for (const name of names ?? []) {
      if (name.startsWith(location.scratchPrefix)) {
        await rm(path.join(location.parent, name), {
          force: true,
          recursive: true,
        });
      }
    }
  }
  async function stage(
    version: SelectedVersion,
    location: Location,
    signal?: AbortSignal
  ) {
    await frozen(version);
    await mkdir(location.parent, { mode: 0o700, recursive: true });
    await sweep(location);
    const staged = location.scratch();
    try {
      await stageProjection(projection(version), staged, signal);
    } catch (error) {
      await rm(staged, { force: true, recursive: true });
      throw error;
    }
    return staged;
  }
  /** `staged` becomes the checkout; returns where the previous files went. */
  async function swap(staged: string, location: Location) {
    const aside = (await exists(location.checkout)) ? location.scratch() : null;
    if (aside) {
      await rename(location.checkout, aside);
    }
    try {
      await rename(staged, location.checkout);
    } catch (error) {
      if (aside) {
        await rename(aside, location.checkout);
      }
      throw error;
    }
    return aside;
  }

  return Object.freeze<ModuleSelectedCheckouts>({
    ensure: ({ version, signal }) =>
      turns.run(version.moduleId, async () => {
        const location = locate(version.moduleId);
        await frozen(version);
        await sweep(location);
        if (
          !(await projectionMatches(projection(version), location.checkout))
        ) {
          const aside = await swap(
            await stage(version, location, signal),
            location
          );
          if (aside) {
            await rm(aside, { force: true, recursive: true });
          }
        }
        return { hostPath: location.checkout };
      }),
    select: (version, record, signal) =>
      turns.run(version.moduleId, async () => {
        const location = locate(version.moduleId);
        const aside = await swap(
          await stage(version, location, signal),
          location
        );
        let recorded: Awaited<ReturnType<typeof record>>;
        try {
          recorded = await record();
        } catch (error) {
          await rm(location.checkout, { force: true, recursive: true });
          if (aside) {
            await rename(aside, location.checkout);
          }
          throw error;
        }
        if (aside) {
          await rm(aside, { force: true, recursive: true });
        }
        return recorded;
      }),
  });
}

async function exists(target: string) {
  return (await lstat(target).catch(missing)) !== undefined;
}

function missing(error: unknown): undefined {
  if (
    !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
  ) {
    throw error;
  }
}
