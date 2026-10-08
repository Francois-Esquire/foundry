import type { Artifacts, ContentId } from "@foundry/artifacts";
import type { Page, PageInput } from "@foundry/core/pagination";

import { decodeUtf8 } from "@foundry/lib/encoding";
import { canonicalizeJson } from "@foundry/lib/json";
import { byCodeUnit } from "@foundry/lib/ordering";

import type { ModuleId, ModuleVersion } from "./domain";
import { defineModuleVersion } from "./domain";
import type { ModuleManifest } from "./manifest";
import {
  MODULE_MANIFEST_SOURCE_PATH,
  ModuleManifestValidationError,
  parseModuleManifestSourceText,
} from "./manifest";
import type { ModuleStore } from "./store/contract";
import { page } from "./store/page";

/** Where a built Content carries its manifest. */
export const MODULE_CONTENT_MANIFEST_PATH = `source/${MODULE_MANIFEST_SOURCE_PATH}`;

export type ModuleVersionArtifacts = Pick<
  Artifacts,
  "getContent" | "listContents" | "readFile"
>;

export interface ModuleVersions {
  /** Frozen, SemVer-tagged Contents that validate, in Content id order. */
  list(input: {
    readonly moduleId: ModuleId;
    readonly page?: PageInput;
  }): Promise<Page<ModuleVersion>>;
  /**
   * The pinned Content as a validated version of the Module. `null` when the
   * Module or the Content does not exist; throws
   * `ModuleManifestValidationError` when the Content exists but is not a
   * valid version of this Module.
   */
  load(input: {
    readonly moduleId: ModuleId;
    readonly contentId: ContentId;
  }): Promise<ModuleVersion | null>;
}

export function createModuleVersions(options: {
  readonly artifacts: ModuleVersionArtifacts;
  readonly store: Pick<ModuleStore, "loadModule" | "loadRetainedManifest">;
}): ModuleVersions {
  const load: ModuleVersions["load"] = async ({ moduleId, contentId }) => {
    const module = await options.store.loadModule(moduleId);
    if (module === null) {
      return null;
    }
    const content = await options.artifacts.getContent(contentId);
    if (content === null) {
      return null;
    }
    return defineModuleVersion({
      artifact: content.artifact,
      content,
      manifest: await contentManifest(options, contentId),
      module,
    });
  };
  const resolver: ModuleVersions = {
    async list({ moduleId, page: pageInput }) {
      const module = await options.store.loadModule(moduleId);
      if (module === null) {
        return page([], pageInput ?? {}, identity, copy);
      }
      const versions: ModuleVersion[] = [];
      for (const summary of await options.artifacts.listContents(
        module.artifactId,
        { state: "frozen", tagged: true }
      )) {
        try {
          const version = await load({ contentId: summary.id, moduleId });
          if (version !== null) {
            versions.push(version);
          }
        } catch (error) {
          // A frozen tagged Content that is not a version is simply not listed.
          if (!(error instanceof ModuleManifestValidationError)) {
            throw error;
          }
        }
      }
      versions.sort(byCodeUnit((version) => version.contentId));
      return page(versions, pageInput ?? {}, identity, copy);
    },
    load,
  };
  return Object.freeze(resolver);
}

/** `null` when the Content embeds no manifest source. */
export async function embeddedManifest(
  artifacts: Pick<Artifacts, "readFile">,
  contentId: ContentId
): Promise<ModuleManifest | null> {
  const file = await artifacts.readFile(
    contentId,
    MODULE_CONTENT_MANIFEST_PATH
  );
  if (file === null) {
    return null;
  }
  const text = decodeUtf8(file.blob);
  if (text === null) {
    throw new ModuleManifestValidationError(
      `Content ${contentId} manifest source is not UTF-8`
    );
  }
  return parseModuleManifestSourceText(text);
}

/**
 * Drops each retained manifest that its Content's embedded source reproduces.
 * What remains is exactly the set no Content can supply: output-only imports
 * and legacy disagreements. Idempotent; an unreadable Content keeps its row.
 */
export async function pruneRetainedManifests(options: {
  readonly artifacts: Pick<Artifacts, "readFile">;
  readonly store: Pick<
    ModuleStore,
    "listRetainedManifests" | "dropRetainedManifest"
  >;
}): Promise<void> {
  for (const retained of await options.store.listRetainedManifests()) {
    const embedded = await embeddedManifest(
      options.artifacts,
      retained.contentId
    ).catch(() => null);
    if (
      embedded !== null &&
      canonicalizeJson(embedded) === canonicalizeJson(retained.manifest)
    ) {
      await options.store.dropRetainedManifest(retained.contentId);
    }
  }
}

async function contentManifest(
  options: Parameters<typeof createModuleVersions>[0],
  contentId: ContentId
): Promise<ModuleManifest> {
  const retained = await options.store.loadRetainedManifest(contentId);
  if (retained !== null) {
    return retained;
  }
  const embedded = await embeddedManifest(options.artifacts, contentId);
  if (embedded === null) {
    throw new ModuleManifestValidationError(
      `Content ${contentId} carries no Module manifest`
    );
  }
  return embedded;
}

function identity(version: ModuleVersion): string {
  return version.contentId;
}

function copy(version: ModuleVersion): ModuleVersion {
  return version;
}
