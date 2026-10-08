import type {
  Artifact,
  ArtifactId,
  Content,
  ContentId,
} from "@foundry/artifacts";
import type { StorageTree } from "@foundry/core/storage";
import { z } from "zod";
import { MODULE_MIME } from "./constants";
import type { ModuleManifest } from "./manifest";
import {
  assertModuleManifestPaths,
  assertSemverTag,
  ModuleManifestValidationError,
  parseModuleManifest,
} from "./manifest";

export const installationIdSchema = z
  .string()
  .min(1, "InstallationId must not be empty")
  .brand("InstallationId");
export type InstallationId = z.infer<typeof installationIdSchema>;

export const runtimeInstanceIdSchema = z
  .string()
  .min(1, "RuntimeInstanceId must not be empty")
  .brand("RuntimeInstanceId");
export type RuntimeInstanceId = z.infer<typeof runtimeInstanceIdSchema>;

export const moduleIdSchema = z
  .string()
  .min(1, "ModuleId must not be empty")
  .brand("ModuleId");
export type ModuleId = z.infer<typeof moduleIdSchema>;

export const INSTALLATION_STATUSES = [
  "disabled",
  "starting",
  "active",
  "stopping",
  "failed",
] as const;

/**
 * One column. `disabled`: operator intent, nothing runs. `starting` /
 * `active` / `stopping`: the program. `failed`: the last start or release
 * change failed; the operator enables again to retry.
 */
export type InstallationStatus = (typeof INSTALLATION_STATUSES)[number];

/** Consecutive failed starts before boot recovery stops retrying. */
export const MAX_START_ATTEMPTS = 3;

/**
 * Stable control-plane identity with one immutable backing Artifact.
 * ModuleId and ArtifactId name different entities even though the Store
 * enforces a one-to-one relationship between them.
 */
export interface Module {
  readonly artifactId: ArtifactId;
  readonly id: ModuleId;
}

/**
 * One version of a Module: a frozen Content of its Artifact with a SemVer tag,
 * resolved on demand. `digest` is the Content's tree digest. Nothing persists
 * a version; the Content is the record.
 */
export interface ModuleVersion {
  readonly artifactId: ArtifactId;
  readonly contentId: ContentId;
  readonly digest: string;
  readonly manifest: ModuleManifest;
  readonly moduleId: ModuleId;
  readonly tag: string;
}

export interface Installation {
  readonly containerId: string | null;
  readonly contentId: ContentId;
  readonly createdAt: Date;
  /** The only concurrency token; a running program is bound to the one it saw. */
  readonly generation: number;
  readonly id: InstallationId;
  readonly moduleId: ModuleId;
  /** Failed starts since the last `active`; reset by a user enable or a version change. */
  readonly startAttempts: number;
  readonly status: InstallationStatus;
  readonly updatedAt: Date;
}

export function defineModule(input: {
  readonly id: ModuleId;
  readonly artifact: Pick<Artifact, "id" | "type">;
}): Module {
  if (input.artifact.type !== MODULE_MIME) {
    throw new ModuleManifestValidationError(
      `Artifact ${input.artifact.id} is not a Module Artifact`
    );
  }
  return Object.freeze({
    artifactId: input.artifact.id,
    id: moduleIdSchema.parse(input.id),
  });
}

export function defineModuleVersion(input: {
  readonly module: Module;
  readonly artifact: Pick<Artifact, "id" | "type">;
  readonly content: Pick<
    Content,
    "id" | "artifactId" | "state" | "tag" | "digest"
  > & { readonly tree: StorageTree };
  readonly manifest: unknown;
}): ModuleVersion {
  if (input.artifact.type !== MODULE_MIME) {
    throw new ModuleManifestValidationError(
      `Artifact ${input.artifact.id} is not a Module Artifact`
    );
  }
  if (input.module.artifactId !== input.artifact.id) {
    throw new ModuleManifestValidationError(
      `Module ${input.module.id} does not belong to Artifact ${input.artifact.id}`
    );
  }
  if (input.content.artifactId !== input.artifact.id) {
    throw new ModuleManifestValidationError(
      `Content ${input.content.id} does not belong to Artifact ${input.artifact.id}`
    );
  }
  if (input.content.state !== "frozen") {
    throw new ModuleManifestValidationError(
      `Content ${input.content.id} is ${input.content.state}; a Module version must be frozen`
    );
  }
  if (input.content.tag === null) {
    throw new ModuleManifestValidationError(
      `Content ${input.content.id} has no SemVer tag`
    );
  }
  const manifest = parseModuleVersionContent({
    manifest: input.manifest,
    tag: input.content.tag,
    tree: input.content.tree,
  });
  return Object.freeze({
    artifactId: input.artifact.id,
    contentId: input.content.id,
    digest: input.content.digest,
    manifest,
    moduleId: input.module.id,
    tag: input.content.tag,
  });
}

/** The version rules that need no Content identity: tag, Manifest, and tree. */
export function parseModuleVersionContent(input: {
  readonly tag: string;
  readonly tree: StorageTree;
  readonly manifest: unknown;
}): ModuleManifest {
  assertSemverTag(input.tag);
  const manifest = parseModuleManifest(input.manifest);
  for (const [path, entry] of Object.entries(input.tree)) {
    if (
      path.startsWith("outputs/") &&
      entry.type !== "file" &&
      entry.type !== "directory"
    ) {
      throw new ModuleManifestValidationError(
        `Module output ${JSON.stringify(path)} must be a file or directory; found ${entry.type}`
      );
    }
  }
  assertModuleManifestPaths(
    manifest,
    Object.keys(input.tree).filter((path) => input.tree[path]?.type === "file")
  );
  return manifest;
}

export function createDisabledInstallation(input: {
  readonly id: InstallationId;
  readonly version: Pick<ModuleVersion, "moduleId" | "contentId">;
  readonly now: Date;
}): Installation {
  return Object.freeze({
    containerId: null,
    contentId: input.version.contentId,
    createdAt: new Date(input.now),
    generation: 0,
    id: installationIdSchema.parse(input.id),
    moduleId: input.version.moduleId,
    startAttempts: 0,
    status: "disabled",
    updatedAt: new Date(input.now),
  });
}
