import {
  type ArtifactCursor,
  type ArtifactManager,
  type ArtifactResolved,
  type ContentId,
  contentIdSchema,
} from "@foundry/artifacts";
import { canonicalizeJson } from "@foundry/lib/json";
import { byCodeUnit } from "@foundry/lib/ordering";
import { MODULE_MIME } from "@foundry/modules/constants";
import type { InstallationId, Module, ModuleId } from "@foundry/modules/domain";
import {
  INSTALLATION_STATUSES,
  installationIdSchema,
  moduleIdSchema,
} from "@foundry/modules/domain";
import {
  ModuleStoreConflictError,
  ModuleStoreNotFoundError,
} from "@foundry/modules/errors";
import type { ModuleManifest } from "@foundry/modules/manifest";
import { parseModuleManifest } from "@foundry/modules/manifest";
import { page } from "@foundry/modules/page";
import type {
  BeginInstallationTransitionInput,
  CreateInstallationInput,
  DeleteInstallationInput,
  DeleteModuleInput,
  ListInstallationsInput,
  ModuleCommands,
  ModuleGatewayContext,
  RegisterModuleInput,
  ReplaceInstallationGrantsInput,
  RetainedManifest,
  RetainManifestInput,
  RevokeInstallationGrantInput,
  SelectedVersion,
  SelectInstallationVersionInput,
  SetInstallationContainerIdInput,
  SettleInstallationStatusInput,
} from "@foundry/modules/registry";
import { z } from "zod";
import {
  atGeneration,
  beginTransition,
  copyGrant,
  copyInstallation,
  copyModule,
  type InstallationChange,
  type InstallationTarget,
  newInstallation,
  replaceGrants,
  revokeGrant,
  type StoredInstallation,
  selectVersion,
  setContainer,
  settle,
} from "./installation-rules";

class ModuleStoreCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModuleStoreCorruptionError";
  }
}

export interface ArtifactModuleStore extends ModuleCommands {
  moduleArtifacts(): Promise<readonly ArtifactResolved[]>;
}

const isoDateSchema = z.iso.datetime().transform((value) => new Date(value));

const storedGrantSchema = z.object({
  capability: z.string().min(1),
  constraintsDigest: z.string().min(1),
  createdAt: isoDateSchema,
  version: z.number().int().positive(),
});

const storedInstallationSchema = z.object({
  grants: z.array(storedGrantSchema),
  installation: z.object({
    containerId: z.string().min(1).nullable(),
    contentId: contentIdSchema,
    createdAt: isoDateSchema,
    generation: z.number().int().nonnegative(),
    id: installationIdSchema,
    moduleId: moduleIdSchema,
    startAttempts: z.number().int().nonnegative(),
    status: z.enum(INSTALLATION_STATUSES),
    updatedAt: isoDateSchema,
  }),
});

const moduleMetadataSchema = z.object({
  installations: z.record(z.string(), storedInstallationSchema).optional(),
  moduleId: moduleIdSchema,
  retainedManifests: z.record(contentIdSchema, z.unknown()).optional(),
});

interface ModuleRecord {
  readonly artifact: ArtifactResolved;
  readonly installations: ReadonlyMap<InstallationId, StoredInstallation>;
  readonly module: Module;
  readonly raw: ReadonlyMap<InstallationId, unknown>;
  readonly retained: ReadonlyMap<ContentId, unknown>;
}

interface ModuleEntry {
  readonly artifact: ArtifactResolved;
  readonly duplicated: boolean;
  readonly module: Module;
}

export interface ArtifactModuleStoreOptions {
  readonly skipped?: (error: ModuleStoreCorruptionError) => void;
}

export function createArtifactModuleStore(
  artifacts: ArtifactManager,
  options: ArtifactModuleStoreOptions = {}
): ArtifactModuleStore {
  const reported = new Set<string>();
  const skip = (error: ModuleStoreCorruptionError) => {
    if (!reported.has(error.message)) {
      reported.add(error.message);
      options.skipped?.(error);
    }
  };

  async function claims(): Promise<ModuleEntry[]> {
    const found: ArtifactResolved[] = [];
    let cursor: ArtifactCursor | undefined;
    do {
      const listed = await artifacts.list({
        includeArchived: true,
        type: MODULE_MIME,
        ...(cursor ? { cursor } : {}),
      });
      found.push(...listed.items);
      cursor = listed.nextCursor;
    } while (cursor);
    const claimed: { artifact: ArtifactResolved; id: ModuleId }[] = [];
    for (const artifact of found) {
      if (artifact.metadata.moduleId === undefined) {
        continue;
      }
      const id = moduleIdSchema.safeParse(artifact.metadata.moduleId);
      if (id.success) {
        claimed.push({ artifact, id: id.data });
      } else {
        skip(
          new ModuleStoreCorruptionError(
            `Module Artifact ${artifact.id} has an invalid Module id`
          )
        );
      }
    }
    const counts = new Map<string, number>();
    for (const { id } of claimed) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return claimed.map(({ artifact, id }) => {
      const duplicated = (counts.get(id) ?? 0) > 1;
      if (duplicated) {
        skip(duplicateError(id));
      }
      return {
        artifact,
        duplicated,
        module: Object.freeze({ artifactId: artifact.id, id }),
      };
    });
  }

  async function entries(): Promise<ModuleEntry[]> {
    return (await claims()).filter(
      (entry) => !entry.duplicated && entry.artifact.status !== "archived"
    );
  }

  function decode(entry: ModuleEntry): ModuleRecord {
    if (entry.duplicated) {
      throw duplicateError(entry.module.id);
    }
    return readRecord(entry.artifact, entry.module);
  }

  async function readable(): Promise<ModuleRecord[]> {
    const found: ModuleRecord[] = [];
    for (const entry of await entries()) {
      try {
        found.push(decode(entry));
      } catch (error) {
        if (!(error instanceof ModuleStoreCorruptionError)) {
          throw error;
        }
        skip(error);
      }
    }
    return found;
  }

  async function entryOf(moduleId: ModuleId): Promise<ModuleEntry | null> {
    const entry = (await claims()).find(
      (candidate) => candidate.module.id === moduleId
    );
    if (entry?.duplicated) {
      throw duplicateError(moduleId);
    }
    return entry ?? null;
  }

  async function recordOf(moduleId: ModuleId): Promise<ModuleRecord | null> {
    const entry = await entryOf(moduleId);
    return entry ? decode(entry) : null;
  }

  async function holders(
    key: "installations" | "retainedManifests",
    id: string
  ): Promise<ModuleRecord[]> {
    return (await claims())
      .filter((entry) => holds(entry.artifact.metadata[key], id))
      .map(decode);
  }

  async function holderOf(installationId: InstallationId): Promise<{
    readonly record: ModuleRecord;
    readonly stored: StoredInstallation;
  } | null> {
    for (const record of await holders("installations", installationId)) {
      const stored = record.installations.get(installationId);
      if (stored !== undefined) {
        return { record, stored };
      }
    }
    return null;
  }

  async function saveInstallations(
    record: ModuleRecord,
    installations: ReadonlyMap<InstallationId, StoredInstallation>
  ): Promise<void> {
    await artifacts.patchArtifactMetadata(record.artifact.id, {
      installations:
        installations.size === 0
          ? undefined
          : Object.fromEntries(
              [...installations]
                .sort(byCodeUnit(([id]) => id))
                .map(([id, stored]) => [
                  id,
                  encodeInstallation(stored, record.raw.get(id)),
                ])
            ),
    });
  }

  async function holderAt(target: InstallationTarget): Promise<{
    readonly record: ModuleRecord;
    readonly stored: StoredInstallation;
  }> {
    const holder = await holderOf(target.installationId);
    if (holder === null) {
      throw new ModuleStoreNotFoundError(target.installationId);
    }
    atGeneration(
      holder.stored,
      target.installationId,
      target.expectedGeneration
    );
    return holder;
  }

  function mutate<Result>(
    target: InstallationTarget,
    rule: (
      stored: StoredInstallation
    ) => InstallationChange<Result> | Promise<InstallationChange<Result>>
  ): Promise<Result> {
    return write(async () => {
      const { record, stored } = await holderAt(target);
      const { next, result } = await rule(stored);
      await saveInstallations(
        record,
        new Map(record.installations).set(target.installationId, next)
      );
      return result;
    });
  }

  async function assertModuleVersion(version: SelectedVersion): Promise<void> {
    const owner = await entryOf(version.moduleId);
    const content = await artifacts.getContent(version.contentId);
    if (
      owner?.module.artifactId !== version.artifactId ||
      content?.artifactId !== version.artifactId
    ) {
      throw new ModuleStoreConflictError(
        `Content ${version.contentId} does not belong to a registered Module`
      );
    }
  }

  async function registerModule(module: Module): Promise<Module> {
    const existing = await entryOf(module.id);
    const artifact = await artifacts.get(module.artifactId);
    if (
      !artifact ||
      artifact.type !== MODULE_MIME ||
      (existing && existing.module.artifactId !== module.artifactId) ||
      (artifact.metadata.moduleId !== undefined &&
        artifact.metadata.moduleId !== module.id)
    ) {
      throw new ModuleStoreConflictError(
        `Module ${module.id} conflicts with Artifact ${module.artifactId}`
      );
    }
    if (artifact.metadata.moduleId !== module.id) {
      await artifacts.patchArtifactMetadata(module.artifactId, {
        moduleId: module.id,
      });
    }
    return copyModule(module);
  }

  function write<T>(operation: () => Promise<T>): Promise<T> {
    return artifacts.transaction(() => operation());
  }

  const store: ArtifactModuleStore = {
    beginInstallationTransition: (input: BeginInstallationTransitionInput) =>
      mutate(input, beginTransition(input)),

    createInstallation: (input: CreateInstallationInput) =>
      write(async () => {
        const created = newInstallation(input);
        const { installation } = created;
        await assertModuleVersion(input.version);
        if (
          (await claims()).some((entry) =>
            holds(entry.artifact.metadata.installations, installation.id)
          )
        ) {
          throw new ModuleStoreConflictError(
            `Installation ${installation.id} already exists`
          );
        }
        const owner = await recordOf(installation.moduleId);
        if (owner === null) {
          throw new ModuleStoreConflictError(
            `Module ${installation.moduleId} is not registered`
          );
        }
        await saveInstallations(
          owner,
          new Map(owner.installations).set(installation.id, created)
        );
        return copyInstallation(installation);
      }),

    deleteInstallation: (input: DeleteInstallationInput) =>
      write(async () => {
        const { record } = await holderAt(input);
        const remaining = new Map(record.installations);
        remaining.delete(input.installationId);
        await saveInstallations(record, remaining);
      }),

    deleteModule: ({ moduleId }: DeleteModuleInput) =>
      write(async () => {
        const found = await recordOf(moduleId);
        if (found === null) {
          throw new ModuleStoreConflictError(
            `Module ${moduleId} is not registered`
          );
        }
        const [installation] = found.installations.keys();
        if (installation !== undefined) {
          throw new ModuleStoreConflictError(
            `Module ${moduleId} still has Installation ${installation}`
          );
        }
        await artifacts.patchArtifactMetadata(found.artifact.id, {
          installations: undefined,
          moduleId: undefined,
          retainedManifests: undefined,
        });
      }),

    dropRetainedManifest: (contentId: ContentId) =>
      write(async () => {
        for (const candidate of await holders("retainedManifests", contentId)) {
          const remaining = [...candidate.retained].filter(
            ([id]) => id !== contentId
          );
          await artifacts.patchArtifactMetadata(candidate.artifact.id, {
            retainedManifests:
              remaining.length === 0
                ? undefined
                : Object.fromEntries(remaining),
          });
        }
      }),

    async listInstallations({
      moduleId,
      ...input
    }: ListInstallationsInput = {}) {
      const owners =
        moduleId === undefined
          ? await readable()
          : [await recordOf(moduleId)].filter((found) => found !== null);
      return page(
        owners
          .flatMap((candidate) =>
            [...candidate.installations.values()].map(
              (stored) => stored.installation
            )
          )
          .sort(byCodeUnit((installation) => installation.id)),
        input,
        (installation) => installation.id,
        copyInstallation
      );
    },

    async listModules(input = {}) {
      return page(
        (await entries())
          .map((entry) => entry.module)
          .sort(byCodeUnit((module) => module.id)),
        input,
        (module) => module.id,
        copyModule
      );
    },

    async listRetainedManifests(): Promise<readonly RetainedManifest[]> {
      const found: RetainedManifest[] = [];
      for (const candidate of await readable()) {
        for (const [contentId, value] of candidate.retained) {
          try {
            found.push(
              Object.freeze({ contentId, manifest: parseModuleManifest(value) })
            );
          } catch (error) {
            skip(
              new ModuleStoreCorruptionError(
                `Module ${candidate.module.id} retains an unreadable manifest for Content ${contentId}: ${String(error)}`
              )
            );
          }
        }
      }
      return found.sort(byCodeUnit(({ contentId }) => contentId));
    },

    async loadGatewayContext(
      installationId: InstallationId
    ): Promise<ModuleGatewayContext | null> {
      const holder = await holderOf(installationId);
      return holder
        ? Object.freeze({
            grants: Object.freeze(holder.stored.grants.map(copyGrant)),
            installation: copyInstallation(holder.stored.installation),
          })
        : null;
    },

    async loadModule(moduleId: ModuleId): Promise<Module | null> {
      const found = await entryOf(moduleId);
      return found ? copyModule(found.module) : null;
    },

    async loadRetainedManifest(
      contentId: ContentId
    ): Promise<ModuleManifest | null> {
      for (const candidate of await holders("retainedManifests", contentId)) {
        const value = candidate.retained.get(contentId);
        if (value !== undefined) {
          return parseModuleManifest(value);
        }
      }
      return null;
    },

    moduleArtifacts: async () =>
      (await entries()).map((entry) => entry.artifact),

    registerModule: ({ module }: RegisterModuleInput) =>
      write(() => registerModule(module)),

    replaceInstallationGrants: (input: ReplaceInstallationGrantsInput) =>
      mutate(input, replaceGrants(input)),

    retainManifest: ({ module, contentId, manifest }: RetainManifestInput) =>
      write(async () => {
        await registerModule(module);
        for (const other of await holders("retainedManifests", contentId)) {
          const previous = other.retained.get(contentId);
          if (previous === undefined) {
            continue;
          }
          if (
            other.module.id !== module.id ||
            canonicalizeJson(previous) !== canonicalizeJson(manifest)
          ) {
            throw new ModuleStoreConflictError(
              `Content ${contentId} already retains a different manifest`
            );
          }
          return;
        }
        const own = await recordOf(module.id);
        await artifacts.patchArtifactMetadata(module.artifactId, {
          retainedManifests: {
            ...Object.fromEntries(own?.retained ?? []),
            [contentId]: structuredClone(manifest),
          },
        });
      }),

    revokeInstallationGrant: (input: RevokeInstallationGrantInput) =>
      mutate(input, revokeGrant(input)),

    selectInstallationVersion: (input: SelectInstallationVersionInput) =>
      mutate(input, async (stored) => {
        await assertModuleVersion(input.version);
        return selectVersion(input)(stored);
      }),

    setInstallationContainerId: (input: SetInstallationContainerIdInput) =>
      mutate(input, setContainer(input)),

    settleInstallationStatus: (input: SettleInstallationStatusInput) =>
      mutate(input, settle(input)),

    transaction: (work) =>
      artifacts.transaction((_artifacts, effects) => work(store, effects)),
  };
  return Object.freeze(store);
}

function holds(map: unknown, key: string): boolean {
  return (
    typeof map === "object" &&
    map !== null &&
    !Array.isArray(map) &&
    Object.hasOwn(map, key)
  );
}

function readRecord(artifact: ArtifactResolved, module: Module): ModuleRecord {
  const parsed = moduleMetadataSchema.safeParse(artifact.metadata);
  if (!parsed.success) {
    throw new ModuleStoreCorruptionError(
      `Module ${module.id} has invalid records on Artifact ${artifact.id}: ${parsed.error.message}`
    );
  }
  const moduleId = module.id;
  const installations = new Map<InstallationId, StoredInstallation>();
  const raw = new Map<InstallationId, unknown>();
  const stored = artifact.metadata.installations as
    | Readonly<Record<string, unknown>>
    | undefined;
  for (const [key, entry] of Object.entries(parsed.data.installations ?? {})) {
    if (
      entry.installation.id !== key ||
      entry.installation.moduleId !== moduleId
    ) {
      throw new ModuleStoreCorruptionError(
        `Module Artifact ${artifact.id} has a misfiled Installation ${key}`
      );
    }
    installations.set(entry.installation.id, {
      grants: entry.grants.map(copyGrant),
      installation: copyInstallation(entry.installation),
    });
    raw.set(entry.installation.id, stored?.[key]);
  }
  const retained = new Map<ContentId, unknown>(
    Object.entries(parsed.data.retainedManifests ?? {}) as [
      ContentId,
      unknown,
    ][]
  );
  return { artifact, installations, module, raw, retained };
}

function duplicateError(moduleId: string): ModuleStoreCorruptionError {
  return new ModuleStoreCorruptionError(
    `Module ${moduleId} is registered on more than one Artifact`
  );
}

function fieldsOf(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function encodeInstallation(stored: StoredInstallation, before: unknown) {
  const { installation } = stored;
  const previous = fieldsOf(before);
  const previousGrants = Array.isArray(previous.grants)
    ? previous.grants.map(fieldsOf)
    : [];
  return {
    ...previous,
    grants: stored.grants.map((grant) => ({
      ...previousGrants.find(
        (candidate) =>
          candidate.capability === grant.capability &&
          candidate.version === grant.version &&
          candidate.constraintsDigest === grant.constraintsDigest
      ),
      capability: grant.capability,
      constraintsDigest: grant.constraintsDigest,
      createdAt: grant.createdAt.toISOString(),
      version: grant.version,
    })),
    installation: {
      ...fieldsOf(previous.installation),
      containerId: installation.containerId,
      contentId: installation.contentId,
      createdAt: installation.createdAt.toISOString(),
      generation: installation.generation,
      id: installation.id,
      moduleId: installation.moduleId,
      startAttempts: installation.startAttempts,
      status: installation.status,
      updatedAt: installation.updatedAt.toISOString(),
    },
  };
}
