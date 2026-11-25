import { AsyncLocalStorage } from "node:async_hooks";
import {
  type ArtifactCursor,
  type ArtifactOperations,
  type ArtifactResolved,
  type ArtifactSubstrate,
  Artifacts,
} from "@foundry/artifacts";
import type { ArtifactStore } from "@foundry/artifacts/store";
import {
  MODULE_MIME,
  type Module,
  ModuleStoreConflictError,
  type ModuleUnit,
  moduleIdSchema,
  parseModuleManifest,
} from "@foundry/modules";

type Effects = Parameters<Parameters<ArtifactSubstrate["transaction"]>[0]>[1];

interface ActiveTransaction {
  readonly effects: Effects;
  failed?: { readonly error: unknown };
  open: boolean;
  readonly ops: ArtifactOperations;
}

type PersistenceUnit = ModuleUnit<
  "loadModule" | "loadRetainedManifest" | "registerModule" | "retainManifest"
>;

export function createModulePersistence(store: ArtifactStore) {
  const base = new Artifacts({ store });
  const active = new AsyncLocalStorage<ActiveTransaction>();

  function current(): ActiveTransaction | undefined {
    const scope = active.getStore();
    return scope?.open ? scope : undefined;
  }

  function activeOps(): ArtifactOperations {
    return current()?.ops ?? base;
  }

  async function inTransaction<T>(
    work: (ops: ArtifactOperations, effects: Effects) => Promise<T>
  ): Promise<T> {
    const joined = current();
    if (joined) {
      try {
        return await work(joined.ops, joined.effects);
      } catch (error) {
        joined.failed ??= { error };
        throw error;
      }
    }
    return base.transaction(async (ops, effects) => {
      const scope: ActiveTransaction = { effects, open: true, ops };
      try {
        const result = await active.run(scope, () => work(ops, effects));
        if (scope.failed) {
          throw scope.failed.error;
        }
        return result;
      } finally {
        scope.open = false;
      }
    });
  }

  async function registered(
    ops: ArtifactOperations = activeOps()
  ): Promise<ArtifactResolved[]> {
    const records: ArtifactResolved[] = [];
    let cursor: ArtifactCursor | undefined;
    do {
      const page = await ops.list({
        type: MODULE_MIME,
        ...(cursor ? { cursor } : {}),
      });
      records.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    const identities = new Set<string>();
    return records.filter((artifact) => {
      if (artifact.metadata.moduleId === undefined) {
        return false;
      }
      const id = moduleIdSchema.parse(artifact.metadata.moduleId);
      if (identities.has(id)) {
        throw new Error("Duplicate Module identity in Artifact records");
      }
      identities.add(id);
      return true;
    });
  }

  async function loadModule(
    ops: ArtifactOperations,
    id: Module["id"]
  ): Promise<Module | null> {
    const artifact = (await registered(ops)).find(
      (record) => record.metadata.moduleId === id
    );
    return artifact ? { artifactId: artifact.id, id } : null;
  }

  async function loadRetainedManifest(
    ops: ArtifactOperations,
    contentId: Parameters<PersistenceUnit["loadRetainedManifest"]>[0]
  ) {
    for (const artifact of await registered(ops)) {
      const manifests = artifact.metadata.retainedManifests;
      if (typeof manifests === "object" && manifests !== null) {
        const value: unknown = Object.getOwnPropertyDescriptor(
          manifests,
          contentId
        )?.value;
        if (value !== undefined) {
          return parseModuleManifest(value);
        }
      }
    }
    return null;
  }

  async function registerModule(
    ops: ArtifactOperations,
    { module }: Parameters<PersistenceUnit["registerModule"]>[0]
  ): Promise<Module> {
    const existing = await loadModule(ops, module.id);
    const artifact = await ops.get(module.artifactId);
    if (
      !artifact ||
      artifact.type !== MODULE_MIME ||
      (existing && existing.artifactId !== module.artifactId) ||
      (artifact.metadata.moduleId && artifact.metadata.moduleId !== module.id)
    ) {
      throw new ModuleStoreConflictError(
        "Module identity conflicts with its Artifact"
      );
    }
    await ops.patchArtifactMetadata(module.artifactId, {
      moduleId: module.id,
    });
    return module;
  }

  async function retainManifest(
    ops: ArtifactOperations,
    {
      module,
      contentId,
      manifest,
    }: Parameters<PersistenceUnit["retainManifest"]>[0]
  ): Promise<void> {
    await registerModule(ops, { module });
    const artifact = await ops.get(module.artifactId);
    const retained = artifact?.metadata.retainedManifests ?? {};
    if (
      typeof retained !== "object" ||
      retained === null ||
      Array.isArray(retained)
    ) {
      throw new Error("Invalid retained Module manifests");
    }
    const previous = Object.getOwnPropertyDescriptor(
      retained,
      contentId
    )?.value;
    if (previous && JSON.stringify(previous) !== JSON.stringify(manifest)) {
      throw new ModuleStoreConflictError(
        "Module version already retains a different manifest"
      );
    }
    await ops.patchArtifactMetadata(module.artifactId, {
      retainedManifests: { ...retained, [contentId]: manifest },
    });
  }

  function unitOver(ops: ArtifactOperations): PersistenceUnit {
    return {
      loadModule: (id) => loadModule(ops, id),
      loadRetainedManifest: (contentId) => loadRetainedManifest(ops, contentId),
      registerModule: (input) => registerModule(ops, input),
      retainManifest: (input) => retainManifest(ops, input),
      transaction: (work) =>
        inTransaction((txOps, effects) => work(unitOver(txOps), effects)),
    };
  }

  const artifacts: ArtifactSubstrate = {
    archive: (id) => activeOps().archive(id),
    bind: (apply) => base.bind(apply),
    clearFailedContent: (input) => activeOps().clearFailedContent(input),
    create: (input) => activeOps().create(input),
    delete: (id) => activeOps().delete(id),
    deleteContent: (input) => activeOps().deleteContent(input),
    findContent: (id, by) => activeOps().findContent(id, by),
    fork: (input) => activeOps().fork(input),
    freeze: (id, option) => activeOps().freeze(id, option),
    get: (id) => activeOps().get(id),
    getContent: (id) => activeOps().getContent(id),
    list: (input) => activeOps().list(input),
    listContents: (id, input) => activeOps().listContents(id, input),
    observe: (changed) => base.observe(changed),
    patchArtifactMetadata: (id, patch) =>
      activeOps().patchArtifactMetadata(id, patch),
    readFile: (id, path) => activeOps().readFile(id, path),
    readFileRange: (id, path, range) =>
      activeOps().readFileRange(id, path, range),
    readNamedRoot: (id, name) => activeOps().readNamedRoot(id, name),
    readRoot: (id) => activeOps().readRoot(id),
    readThumbnail: (id) => activeOps().readThumbnail(id),
    recover: () => base.recover(),
    rename: (id, name) => activeOps().rename(id, name),
    revise: (input) => activeOps().revise(input),
    select: (input) => activeOps().select(input),
    setMetadata: (id, patch) => activeOps().setMetadata(id, patch),
    sweep: (input) => activeOps().sweep(input),
    tag: (id, tag) => activeOps().tag(id, tag),
    transaction: (work) => inTransaction(work),
    unarchive: (id) => activeOps().unarchive(id),
    write: (input) => activeOps().write(input),
  };

  const modules: PersistenceUnit = {
    loadModule: (id) => loadModule(activeOps(), id),
    loadRetainedManifest: (contentId) =>
      loadRetainedManifest(activeOps(), contentId),
    registerModule: (input) =>
      inTransaction((txOps) => registerModule(txOps, input)),
    retainManifest: (input) =>
      inTransaction((txOps) => retainManifest(txOps, input)),
    transaction: (work) =>
      inTransaction((txOps, effects) => work(unitOver(txOps), effects)),
  };

  return { artifacts, modules, registered };
}
