import { join } from "node:path";
import {
  type ArtifactStore,
  artifactIdSchema,
  contentIdSchema,
} from "@foundry/artifacts";
import { JsonArtifactStore } from "@foundry/artifacts/node";
import { type ModuleVersion, moduleIdSchema } from "@foundry/modules/domain";
import type { ModuleCapabilityCatalog } from "@foundry/modules/gateway/types";
import {
  MODULE_MANIFEST_SOURCE_PATH,
  type ModuleManifest,
  parseModuleManifestSourceText,
} from "@foundry/modules/manifest";
import { importModulePackage } from "@foundry/modules/package";
import { createModuleProjects } from "@foundry/modules/projects";
import { createModuleVersions } from "@foundry/modules/version";
import type {
  SourceOrigin,
  SourceSaves,
} from "~/main/execution/source-evidence";
import type {
  ModuleDetails,
  ModuleSourceRevision,
  ModuleSummary,
} from "~/shared/modules";
import { modulePersistence } from "./artifact-store";
import { worksCapabilityCatalog } from "./capabilities";
import { moduleStarter } from "./starter";

const MANIFEST_PATH = `source/${MODULE_MANIFEST_SOURCE_PATH}`;
const utf8 = new TextDecoder("utf-8", { fatal: true });

export interface ModuleLibrary {
  create(name: string): Promise<ModuleSummary>;
  details(id: string): Promise<ModuleDetails | null>;
  importPackage(encoded: string): Promise<ModuleSummary>;
  list(): Promise<ModuleSummary[]>;
  /**
   * The Manifest of the Module's saved source, read from its records alone:
   * no disk synchronization and no other source file. `null` without a
   * `foundry.module.json`; throws for an unknown Module.
   */
  manifest(id: string): Promise<ModuleManifest | null>;
  /** Publish a build's outputs as a frozen release, attributed to that build. */
  publish(
    id: string,
    expected: ModuleSourceRevision,
    release: BuiltRelease
  ): Promise<PublishedRelease>;
  release(id: string, contentId: string): Promise<ModuleVersion | null>;
  /** Save a person's edits to the Module's working source. */
  saveSource(
    id: string,
    source: Record<string, string>,
    expected: ModuleSourceRevision
  ): Promise<ModuleSourceRevision>;
}

/** What a build publishes. */
interface BuiltRelease {
  /** The build run that built it, named as the publish run's parent. */
  readonly builtBy: string;
  readonly outputs: Record<string, Uint8Array>;
  readonly source: Record<string, string>;
  readonly tag: string;
}

interface PublishedRelease {
  readonly binding: ModuleSourceRevision;
  readonly version: ModuleVersion;
}

/**
 * The library's records: everything but its saves, plus the two writes a
 * save commits with, each stamping the save's origin in the same write
 * (spec §4). Only a library's saves call the writes.
 */
export interface ModuleRecords
  extends Omit<ModuleLibrary, "publish" | "saveSource"> {
  writeRelease(
    id: string,
    expected: ModuleSourceRevision,
    release: Omit<BuiltRelease, "builtBy">,
    origin: SourceOrigin
  ): Promise<PublishedRelease>;
  writeSource(
    id: string,
    source: Record<string, string>,
    expected: ModuleSourceRevision,
    origin: SourceOrigin
  ): Promise<ModuleSourceRevision>;
}

/** Where a save commits: right away, or in the local library's per-Module turn. */
export type SavePlacement = <T>(
  moduleId: string,
  commit: () => Promise<T>
) => Promise<T>;

/**
 * A library over `records` whose saves and publishes go through `saves`:
 * each is a recorded run whose commit, placed by `place`, admits the save
 * and then writes it with its origin.
 */
export function savingLibrary(
  records: ModuleRecords,
  saves: SourceSaves,
  place: SavePlacement
): ModuleLibrary {
  const { writeRelease, writeSource, ...reads } = records;
  return {
    ...reads,
    publish: (id, expected, { builtBy, ...release }) =>
      saves.run(
        { actor: "build", builtBy, kind: "release", moduleId: id },
        (origin) =>
          place(id, async () => {
            await saves.admit(id);
            const published = await writeRelease(id, expected, release, origin);
            const { artifactId, contentId, tag } = published.version;
            return {
              saved: {
                artifactId,
                contentId,
                tag,
                updatedAt: published.binding.updatedAt,
              },
              value: published,
            };
          })
      ),
    saveSource: (id, source, expected) =>
      saves.run({ actor: "user", kind: "source", moduleId: id }, (origin) =>
        place(id, async () => {
          await saves.admit(id);
          const binding = await writeSource(id, source, expected, origin);
          return { saved: binding, value: binding };
        })
      ),
  };
}

/** Module records in Works' legacy single-file layout. */
export function openModuleLibrary(userData: string): ModuleRecords {
  return createModuleRecords(
    new JsonArtifactStore({ path: join(userData, "modules", "artifacts.json") })
  );
}

/** A library over `store` with no folders: each save commits as soon as it is admitted. */
export function createModuleLibrary(
  store: ArtifactStore,
  options: ModuleRecordsOptions & { readonly saves: SourceSaves }
): ModuleLibrary {
  return savingLibrary(
    createModuleRecords(store, options),
    options.saves,
    (_moduleId, commit) => commit()
  );
}

export interface ModuleRecordsOptions {
  /** What release builds may select; Works' own providers by default. */
  readonly catalog?: ModuleCapabilityCatalog;
}

export function createModuleRecords(
  store: ArtifactStore,
  options: ModuleRecordsOptions = {}
): ModuleRecords {
  const catalog = options.catalog ?? worksCapabilityCatalog();
  const { artifacts, modules } = modulePersistence(store);
  const registered = () => modules.moduleArtifacts();
  const projects = createModuleProjects({ artifacts, store: modules });
  const versions = createModuleVersions({ artifacts, store: modules });
  function summary(
    artifact: Awaited<ReturnType<typeof registered>>[number]
  ): ModuleSummary {
    return {
      artifactId: artifact.id,
      id: moduleIdSchema.parse(artifact.metadata.moduleId),
      name: artifact.name,
      // Source time: Installation and Grant changes patch the Module
      // Artifact's metadata, which must not read as an edit.
      updatedAt: (
        artifact.content?.updatedAt ?? artifact.updatedAt
      ).toISOString(),
    };
  }
  async function requireSummary(id: string): Promise<ModuleSummary> {
    const found = (await registered()).find(
      (record) => record.metadata.moduleId === id
    );
    if (!found) {
      throw new Error("Module registration was not saved");
    }
    return summary(found);
  }
  async function releases(id: string) {
    const module = await modules.loadModule(moduleIdSchema.parse(id));
    if (!module) {
      return [];
    }
    const contents = await artifacts.listContents(module.artifactId, {
      state: "frozen",
      tagged: true,
    });
    const sorted = contents.toSorted(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()
    );
    const released = await Promise.all(
      sorted.map((content) =>
        versions.load({ contentId: content.id, moduleId: module.id })
      )
    );
    return released.flatMap((version) =>
      version
        ? [
            {
              contentId: version.contentId,
              tag: version.tag,
              views: Object.entries(version.manifest.views).map(
                ([viewId, view]) => ({ id: viewId, ...view })
              ),
            },
          ]
        : []
    );
  }
  return {
    async create(name) {
      const id = moduleIdSchema.parse(crypto.randomUUID());
      await projects.create({
        id,
        name,
        source: await moduleStarter(id, name),
      });
      return requireSummary(id);
    },
    async details(id) {
      const module = await modules.loadModule(moduleIdSchema.parse(id));
      if (!module) {
        return null;
      }
      const record = await requireSummary(id);
      const artifact = await artifacts.get(module.artifactId);
      const tree =
        artifact?.content && "tree" in artifact.content
          ? artifact.content.tree
          : {};
      if (!Object.keys(tree).some((path) => path.startsWith("source/"))) {
        return {
          ...record,
          binding: null,
          releases: await releases(id),
          source: {},
        };
      }
      const workspace = await projects.workspaceSource({ moduleId: module.id });
      return {
        ...record,
        binding: serializeBinding(workspace.binding),
        releases: await releases(id),
        source: { ...workspace.source },
      };
    },
    async importPackage(encoded) {
      const version = await importModulePackage({
        artifacts,
        encoded,
        modules,
      });
      return requireSummary(version.moduleId);
    },
    async list() {
      return (await registered()).map(summary);
    },
    async manifest(id) {
      const module = await modules.loadModule(moduleIdSchema.parse(id));
      if (!module) {
        throw new Error("Module not found");
      }
      const content = (await artifacts.get(module.artifactId))?.content;
      if (
        !(content && "tree" in content) ||
        content.tree[MANIFEST_PATH]?.type !== "file"
      ) {
        return null;
      }
      const file = await artifacts.readFile(content.id, MANIFEST_PATH);
      return file === null
        ? null
        : parseModuleManifestSourceText(utf8.decode(file.blob));
    },
    release(id, contentId) {
      return versions.load({
        contentId: contentIdSchema.parse(contentId),
        moduleId: moduleIdSchema.parse(id),
      });
    },
    async writeRelease(id, expected, release, origin) {
      const published = await projects.publish({
        ...release,
        catalog,
        expected: parseBinding(expected),
        metadata: { origin },
        moduleId: moduleIdSchema.parse(id),
      });
      return {
        binding: serializeBinding(published.binding),
        version: published.version,
      };
    },
    async writeSource(id, source, expected, origin) {
      parseModuleManifestSourceText(source["foundry.module.json"] ?? "");
      const binding = await projects.saveWorkspaceSource({
        expected: parseBinding(expected),
        metadata: { origin },
        moduleId: moduleIdSchema.parse(id),
        source,
      });
      return serializeBinding(binding);
    },
  };
}

function parseBinding(binding: ModuleSourceRevision) {
  return {
    artifactId: artifactIdSchema.parse(binding.artifactId),
    contentId: contentIdSchema.parse(binding.contentId),
    updatedAt: new Date(binding.updatedAt),
  };
}

function serializeBinding(binding: {
  artifactId: string;
  contentId: string;
  updatedAt: Date;
}): ModuleSourceRevision {
  return { ...binding, updatedAt: binding.updatedAt.toISOString() };
}
