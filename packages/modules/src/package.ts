import type {
  Artifact,
  ArtifactOperations,
  Artifacts,
  Content,
  EntryInputs,
} from "@foundry/artifacts";
import { artifactIdSchema, digestTree } from "@foundry/artifacts";
import type { StorageTree } from "@foundry/core/storage";
import {
  isStoragePath,
  storageTree,
  validateStorageTree,
  withParentDirectories,
} from "@foundry/core/storage";
import { digestJson, sha256Hex } from "@foundry/lib/digest";
import {
  base64ToBytes,
  bytesToBase64,
  decodeUtf8,
} from "@foundry/lib/encoding";
import { canonicalizeJson } from "@foundry/lib/json";
import { z } from "zod";
import { MODULE_MIME } from "./constants";
import type { Module, ModuleId, ModuleVersion } from "./domain";
import {
  defineModule,
  defineModuleVersion,
  moduleIdSchema,
  parseModuleVersionContent,
} from "./domain";
import type { ModuleManifest } from "./manifest";
import { parseModuleManifestSourceText } from "./manifest";
import type { ModuleStore } from "./store/contract";
import { MODULE_CONTENT_MANIFEST_PATH } from "./version";

const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
const MAX_TREE_ENTRIES = 4096;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export class ModulePackageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModulePackageError";
  }
}

/**
 * A module version as one portable file: the frozen Content's tree, every
 * blob it names (base64 by digest), and the manifest. Format 3 carries structural
 * entries. Format 2 file-only packages still import; format 1 requires re-export.
 */
export interface ModulePackageEnvelope {
  readonly artifact: {
    readonly id: string;
    readonly name: string;
    readonly type: typeof MODULE_MIME;
  };
  readonly content: {
    readonly tag: string;
    readonly createdAt: string;
    readonly digest: string;
    readonly tree: StorageTree;
    /** blob digest → base64 bytes, one entry per distinct digest in `tree` */
    readonly blobs: Readonly<Record<string, string>>;
    readonly manifest: ModuleManifest;
    /** Tamper evidence for the manifest; the tree is bound by `digest`. */
    readonly manifestDigest: string;
  };
  readonly format: "foundry.module/3";
  readonly module: { readonly id: string };
}

type ParsedModulePackageEnvelope = z.output<typeof envelopeSchema>;

export async function encodeModulePackage(input: {
  readonly module: Module;
  readonly artifact: Pick<Artifact, "id" | "name" | "type">;
  readonly version: ModuleVersion;
  readonly content: Pick<
    Content,
    "id" | "artifactId" | "state" | "tag" | "digest" | "tree" | "createdAt"
  >;
  /** bytes for every path in the tree */
  readonly files: Readonly<Record<string, Uint8Array>>;
}): Promise<string> {
  if (input.artifact.id !== input.version.artifactId) {
    throw new ModulePackageError(
      "Module Package version belongs to another Artifact"
    );
  }
  if (
    input.module.id !== input.version.moduleId ||
    input.module.artifactId !== input.artifact.id
  ) {
    throw new ModulePackageError(
      "Module Package version belongs to another Module"
    );
  }
  if (input.content.id !== input.version.contentId) {
    throw new ModulePackageError(
      "Module Package Content is not the version's Content"
    );
  }
  assertTreeBounds(input.content.tree);
  const blobs = await collectBlobs(input.content.tree, input.files);
  if ((await digestTree(input.content.tree)) !== input.content.digest) {
    throw new ModulePackageError("Module Package Content digest mismatch");
  }
  const { manifest } = defineModuleVersion({
    artifact: input.artifact,
    content: input.content,
    manifest: input.version.manifest,
    module: input.module,
  });
  const source = input.files[MODULE_CONTENT_MANIFEST_PATH];
  const embedded =
    source === undefined
      ? null
      : embeddedManifestSource({
          [MODULE_CONTENT_MANIFEST_PATH]: { bytes: source },
        });
  if (
    embedded !== null &&
    canonicalizeJson(embedded) !== canonicalizeJson(manifest)
  ) {
    throw new ModulePackageError(
      "Cannot export a legacy version whose retained manifest disagrees with its frozen source; rebuild it before exporting"
    );
  }
  const value: ModulePackageEnvelope = {
    artifact: {
      id: input.artifact.id,
      name: input.artifact.name,
      type: MODULE_MIME,
    },
    content: {
      blobs,
      createdAt: input.content.createdAt.toISOString(),
      digest: input.content.digest,
      manifest,
      manifestDigest: await digestJson(manifest),
      tag: input.version.tag,
      tree: storageTree(
        Object.entries(input.content.tree).map(([path, node]) => ({
          ...node,
          path,
        }))
      ),
    },
    format: "foundry.module/3",
    module: { id: input.module.id },
  };
  const encoded = canonicalizeJson(value);
  assertPackageSize(encoded);
  return encoded;
}

/** Import owns the single Artifact transaction; its body uses the handle. */
export type ModulePackageArtifacts = Pick<Artifacts, "transaction">;

type ModulePackageOperations = Pick<
  ArtifactOperations,
  | "get"
  | "create"
  | "write"
  | "revise"
  | "freeze"
  | "listContents"
  | "getContent"
>;

/**
 * Import a package: the Artifact is created if absent, the version becomes a
 * frozen Content tagged with the package's SemVer, and the Module is
 * registered. An output-only package has no embedded manifest source, so its
 * envelope manifest is retained; a package whose embedded source disagrees
 * with its envelope is refused. Importing the same version twice is a no-op.
 */
export async function importModulePackage(input: {
  readonly artifacts: ModulePackageArtifacts;
  readonly modules: Pick<
    ModuleStore,
    "transaction" | "registerModule" | "retainManifest"
  >;
  readonly encoded: string;
}): Promise<ModuleVersion> {
  const validated = await validateModulePackageEnvelope(input.encoded);
  return input.artifacts.transaction(async (artifacts) =>
    input.modules.transaction(async () => {
      const content = await landContent(artifacts, validated);
      if (content.digest !== validated.content.digest) {
        throw new ModulePackageError(
          "Module Package Content digest mismatch after import"
        );
      }
      const artifact = { id: validated.artifact.id, type: MODULE_MIME };
      const module = defineModule({ artifact, id: validated.module.id });
      const version = defineModuleVersion({
        artifact,
        content,
        manifest: validated.content.manifest,
        module,
      });
      if (validated.content.embedsManifest) {
        await input.modules.registerModule({ module });
      } else {
        await input.modules.retainManifest({
          contentId: version.contentId,
          manifest: version.manifest,
          module,
        });
      }
      return version;
    })
  );
}

async function landContent(
  artifacts: ModulePackageOperations,
  validated: ValidatedModulePackage
): Promise<Content> {
  const { artifact, content } = validated;
  const existing = await artifacts.get(artifact.id);
  if (existing === null) {
    const created = await artifacts.create({
      entries: content.entries,
      freeze: { tag: content.tag },
      id: artifact.id,
      name: artifact.name,
      type: MODULE_MIME,
    });
    if (!created.content) {
      throw new ModulePackageError("Module Package import produced no Content");
    }
    return created.content;
  }
  if (existing.type !== MODULE_MIME) {
    throw new ModulePackageError(
      `Artifact ${artifact.id} exists and is not a Module Artifact`
    );
  }
  const tagged = (
    await artifacts.listContents(artifact.id, { state: "frozen", tagged: true })
  ).find((candidate) => candidate.tag === content.tag);
  if (tagged) {
    const loaded = await artifacts.getContent(tagged.id);
    if (!loaded) {
      throw new ModulePackageError("Module Package Content vanished");
    }
    return loaded;
  }
  if (existing.content?.state === "frozen") {
    const successor = await artifacts.revise({
      artifactId: artifact.id,
      changes: { put: content.entries, replace: true },
      contentId: existing.content.id,
      expectedUpdatedAt: existing.content.updatedAt,
    });
    return artifacts.freeze(successor.id, { tag: content.tag });
  }
  return artifacts.write({
    artifactId: artifact.id,
    changes: { put: content.entries, replace: true },
    freeze: { tag: content.tag },
  });
}

interface ValidatedModulePackage {
  readonly artifact: {
    readonly id: Artifact["id"];
    readonly name: string;
  };
  readonly content: {
    readonly tag: string;
    readonly digest: string;
    readonly tree: StorageTree;
    readonly entries: EntryInputs;
    readonly manifest: ModuleManifest;
    /** Whether the tree carries manifest source agreeing with `manifest`. */
    readonly embedsManifest: boolean;
  };
  readonly module: { readonly id: ModuleId };
}

async function validateModulePackageEnvelope(
  encoded: string
): Promise<ValidatedModulePackage> {
  assertPackageSize(encoded);
  const envelope = parseEnvelope(encoded);
  const artifactId = artifactIdSchema.parse(envelope.artifact.id);
  const moduleId = moduleIdSchema.parse(envelope.module.id);
  if (Number.isNaN(new Date(envelope.content.createdAt).getTime())) {
    throw new ModulePackageError("Module Package Content createdAt is invalid");
  }
  const tree =
    envelope.format === "foundry.module/2"
      ? withParentDirectories(envelope.content.tree)
      : envelope.content.tree;
  assertTreeBounds(tree);
  if ((await digestTree(tree)) !== envelope.content.digest) {
    throw new ModulePackageError("Module Package Content digest mismatch");
  }
  const entries = await decodeEntries(tree, envelope.content.blobs);

  const manifest = parseModuleVersionContent({
    manifest: envelope.content.manifest,
    tag: envelope.content.tag,
    tree,
  });
  if ((await digestJson(manifest)) !== envelope.content.manifestDigest) {
    throw new ModulePackageError("Module Package Manifest digest mismatch");
  }
  const embedded = embeddedManifestSource(entries);
  if (
    embedded !== null &&
    canonicalizeJson(embedded) !== canonicalizeJson(manifest)
  ) {
    throw new ModulePackageError(
      "Module Package Manifest disagrees with its embedded source"
    );
  }
  return {
    artifact: { id: artifactId, name: envelope.artifact.name },
    content: {
      digest: envelope.content.digest,
      embedsManifest: embedded !== null,
      entries,
      manifest,
      tag: envelope.content.tag,
      tree,
    },
    module: { id: moduleId },
  };
}

function embeddedManifestSource(entries: EntryInputs): ModuleManifest | null {
  const entry = entries[MODULE_CONTENT_MANIFEST_PATH];
  if (entry === undefined || !("bytes" in entry)) {
    return null;
  }
  const { bytes } = entry;
  if (typeof bytes === "number") {
    return null;
  }
  const text = bytes instanceof Uint8Array ? decodeUtf8(bytes) : (bytes ?? "");
  if (text === null) {
    throw new ModulePackageError(
      "Module Package embedded Manifest source is invalid: not UTF-8"
    );
  }
  try {
    return parseModuleManifestSourceText(text);
  } catch (error) {
    throw new ModulePackageError(
      `Module Package embedded Manifest source is invalid: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

const fileNodeSchema = z.strictObject({
  bytes: z.number().int().nonnegative(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  mime: z.string().nullable(),
  type: z.literal("file").default("file"),
});
const storageNodeSchema = z.union([
  fileNodeSchema,
  z.strictObject({ type: z.literal("directory") }),
  z.strictObject({ target: z.string().min(1), type: z.literal("symlink") }),
  z.strictObject({ type: z.literal("socket") }),
  z.strictObject({ type: z.literal("device") }),
  z.strictObject({ type: z.literal("pipe") }),
]);

const formatSchema = z.enum(["foundry.module/2", "foundry.module/3"]);

const envelopeSchema = z.strictObject({
  artifact: z.strictObject({
    id: z.string(),
    name: z.string().min(1),
    type: z.literal(MODULE_MIME),
  }),
  content: z.strictObject({
    blobs: z.record(z.string(), z.string()),
    createdAt: z.string(),
    digest: z.string(),
    manifest: z.unknown(),
    manifestDigest: z.string(),
    tag: z.string(),
    tree: z.record(z.string(), storageNodeSchema),
  }),
  format: formatSchema,
  module: z.strictObject({ id: z.string() }),
});

function parseEnvelope(encoded: string): ParsedModulePackageEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch (cause) {
    throw new ModulePackageError("Module Package is not valid JSON", {
      cause,
    });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !formatSchema.safeParse((parsed as { readonly format?: unknown }).format)
      .success
  ) {
    throw new ModulePackageError("Unsupported Module Package format");
  }
  if (canonicalizeJson(parsed) !== encoded) {
    throw new ModulePackageError("Module Package is not canonical");
  }
  const result = envelopeSchema.safeParse(parsed);
  if (!result.success) {
    throw new ModulePackageError("Module Package envelope is invalid");
  }
  return result.data;
}

/** Every tree entry's bytes, verified against its digest, as write inputs. */
async function decodeEntries(
  tree: StorageTree,
  blobs: Readonly<Record<string, string>>
): Promise<EntryInputs> {
  const bytesByDigest = new Map<string, Uint8Array>();
  for (const [digest, encoded] of Object.entries(blobs)) {
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(encoded);
    } catch (cause) {
      throw new ModulePackageError("Module Package blob is not base64", {
        cause,
      });
    }
    if ((await sha256Hex(bytes)) !== digest) {
      throw new ModulePackageError("Module Package blob digest mismatch");
    }
    bytesByDigest.set(digest, bytes);
  }
  const entries: Record<string, EntryInputs[string]> = Object.create(
    null
  ) as Record<string, EntryInputs[string]>;
  for (const [path, entry] of Object.entries(tree)) {
    if (entry.type !== "file") {
      entries[path] = entry;
      continue;
    }
    const bytes = bytesByDigest.get(entry.digest);
    if (bytes?.byteLength !== entry.bytes) {
      throw new ModulePackageError(
        `Module Package is missing bytes for ${JSON.stringify(path)}`
      );
    }
    entries[path] = { bytes, mime: entry.mime };
  }
  return entries;
}

async function collectBlobs(
  tree: StorageTree,
  files: Readonly<Record<string, Uint8Array>>
): Promise<Record<string, string>> {
  const blobs: Record<string, string> = {};
  for (const [path, entry] of Object.entries(tree)) {
    if (entry.type !== "file") {
      continue;
    }
    const bytes = files[path];
    if (!bytes) {
      throw new ModulePackageError(
        `Module Package is missing bytes for ${JSON.stringify(path)}`
      );
    }
    if ((await sha256Hex(bytes)) !== entry.digest) {
      throw new ModulePackageError(
        `Module Package bytes for ${JSON.stringify(path)} do not match the tree`
      );
    }
    blobs[entry.digest] ??= bytesToBase64(bytes);
  }
  return blobs;
}

function assertPackageSize(encoded: string): void {
  if (new TextEncoder().encode(encoded).byteLength > MAX_PACKAGE_BYTES) {
    throw new ModulePackageError("Module Package exceeds 32 MiB");
  }
}

function assertTreeBounds(tree: StorageTree): void {
  validateStorageTree(tree);
  const entries = Object.entries(tree);
  if (entries.length > MAX_TREE_ENTRIES) {
    throw new ModulePackageError("Module Package exceeds Content entry limit");
  }
  for (const [path, entry] of entries) {
    if (!isStoragePath(path)) {
      throw new ModulePackageError(
        `Module Package tree path ${JSON.stringify(path)} is not portable`
      );
    }
    if (entry.type === "file" && entry.bytes > MAX_FILE_BYTES) {
      throw new ModulePackageError("Module Package exceeds Content leaf limit");
    }
  }
}
