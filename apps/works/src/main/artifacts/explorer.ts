import {
  type ArtifactCursor,
  type ArtifactOperations,
  type ArtifactResolved,
  artifactIdSchema,
  type Content,
  isUsableContent,
  rootPath,
} from "@foundry/artifacts";
import { createRegistry } from "@foundry/artifacts/registry";
import { moduleInstallationId } from "~/main/modules/runtime/installation";
import type {
  ArtifactResolution,
  ArtifactSummary,
  ArtifactThumbnail,
  EditorOpenRequest,
} from "~/shared/artifacts";
import type { EditorBindings } from "./bindings";
import { EditorPreferences } from "./editor-preferences";
import { isProductArtifact, type ProductFiles, readRange } from "./files";
import {
  chooseEntry,
  type EditorRegistration,
  resolveEditors,
} from "./resolver";

/**
 * The most a thumbnail reads: one transfer chunk at the `artifacts.chunkBytes`
 * default. Larger images show their type's icon instead.
 */
export const THUMBNAIL_MAX_BYTES = 256 * 1024;

const MARKDOWN_MIME = "text/markdown";
const NOT_FILE_NAME = /[^a-z0-9._-]+/g;
const EDGE_DASHES = /^[-.]+|[-.]+$/g;
const MAX_STEM_LENGTH = 80;

/** A refused open: `code` is the RPC error it maps to. */
export class ArtifactOpenError extends Error {
  override readonly name = "ArtifactOpenError";
  readonly code: "CONFLICT" | "NOT_FOUND";

  constructor(code: ArtifactOpenError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface ArtifactExplorer {
  /**
   * A new, empty Markdown File Artifact the user made: one entry, ready to
   * open in an editor. It is a file, not a Module.
   */
  create(input: { name: string }): Promise<{ id: string }>;
  /** Product Artifacts, most recently updated first. */
  list(): Promise<ArtifactSummary[]>;
  /**
   * Open one resolved entry in one of its editors: a new editor binding for
   * it. The entry's Content must still be active and the editor still a
   * candidate; choosing among several is remembered for that MIME type. A
   * write editor of a frozen version is bound to its working successor.
   */
  open(input: {
    contentId: string;
    entry: string;
    id: string;
    moduleId: string;
    view: string;
  }): Promise<EditorOpenRequest>;
  /** What opening this Artifact needs next. `entry` selects a file. */
  resolve(input: { entry?: string; id: string }): Promise<ArtifactResolution>;
  /** A small stored image for the grid, or null. */
  thumbnail(input: { id: string }): Promise<ArtifactThumbnail | null>;
}

export interface ArtifactExplorerOptions {
  /** Where opened entries are bound: the registry the Gateway providers resolve. */
  readonly bindings: EditorBindings;
  /** Editors installed Modules declare; none by default. */
  readonly editors?: () => Promise<readonly EditorRegistration[]>;
  /** Product files: creating them, and opening them for writing. */
  readonly files: Pick<ProductFiles, "create" | "working">;
  /** Where choices between editors are remembered; in memory by default. */
  readonly preferences?: EditorPreferences;
}

type Reads = Pick<ArtifactOperations, "get" | "list" | "readFileRange">;

// Matching only reads the type family; nothing is handled here.
const registry = createRegistry<null>({ fallback: null });

function isImage(mime: string | null): mime is string {
  return mime?.toLowerCase().startsWith("image/") === true;
}

/** The stored file a thumbnail shows: `metadata.thumbnail`, else an image entry. */
function thumbnailPath(content: Content): string | null {
  for (const path of [content.metadata.thumbnail, rootPath(content)]) {
    const node =
      path !== undefined && path !== null && Object.hasOwn(content.tree, path)
        ? content.tree[path]
        : undefined;
    if (
      path &&
      node?.type === "file" &&
      isImage(node.mime) &&
      node.bytes <= THUMBNAIL_MAX_BYTES
    ) {
      return path;
    }
  }
  return null;
}

function summarize(artifact: ArtifactResolved): ArtifactSummary {
  const { content } = artifact;
  const path = content ? rootPath(content) : null;
  const node = content && path !== null ? content.tree[path] : undefined;
  return {
    base: registry.resolve({
      artifact,
      entry: node && path !== null ? { ...node, path } : null,
    }).base,
    files: content
      ? Object.values(content.tree).filter((entry) => entry.type === "file")
          .length
      : 0,
    id: artifact.id,
    name: artifact.name,
    thumbnail: isUsableContent(content) && thumbnailPath(content) !== null,
    type: artifact.type,
    updatedAt: artifact.updatedAt.toISOString(),
  };
}

async function readBounded(
  artifacts: Reads,
  content: Content,
  path: string
): Promise<Uint8Array | null> {
  const chunk = await readRange(artifacts, content.id, path, {
    end: THUMBNAIL_MAX_BYTES,
    start: 0,
  });
  // A file that grew past the bound since listing is not cut short.
  return chunk && chunk.data.byteLength === chunk.bytes ? chunk.data : null;
}

/** A Markdown file name from what the user called it: portable, never empty. */
export function markdownFileName(name: string): string {
  const stem = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(NOT_FILE_NAME, "-")
    .replace(EDGE_DASHES, "")
    .slice(0, MAX_STEM_LENGTH)
    .replace(EDGE_DASHES, "");
  return `${stem || "untitled"}.md`;
}

/**
 * Listing, thumbnails and open resolution over the shared Artifact store.
 * Module Artifacts stay in the store and resolve to their Module when
 * addressed; the listing just leaves them out.
 */
export function createArtifactExplorer(
  artifacts: Reads,
  options: ArtifactExplorerOptions
): ArtifactExplorer {
  const { bindings, files } = options;
  const editors = options.editors ?? (() => Promise.resolve([]));
  const preferences =
    options.preferences ?? new EditorPreferences({ file: null });

  async function load(id: string): Promise<ArtifactResolved> {
    const parsed = artifactIdSchema.safeParse(id);
    const artifact = parsed.success ? await artifacts.get(parsed.data) : null;
    if (!artifact || artifact.archivedAt !== null) {
      throw new ArtifactOpenError("NOT_FOUND", "This artifact was not found");
    }
    return artifact;
  }

  async function resolve(input: {
    entry?: string;
    id: string;
  }): Promise<ArtifactResolution> {
    const artifact = await load(input.id);
    if (!isProductArtifact(artifact)) {
      const { moduleId } = artifact.metadata;
      if (typeof moduleId !== "string") {
        throw new ArtifactOpenError("NOT_FOUND", "This module was not found");
      }
      return { kind: "module", moduleId };
    }
    const summary = {
      id: artifact.id,
      name: artifact.name,
      type: artifact.type,
    };
    const { content } = artifact;
    if (!isUsableContent(content)) {
      return { artifact: summary, kind: "empty" };
    }
    const choice = chooseEntry(content, input.entry);
    if (!choice) {
      throw new ArtifactOpenError(
        "CONFLICT",
        "That file is no longer in this artifact"
      );
    }
    if (choice.kind !== "entry") {
      return choice.kind === "empty"
        ? { artifact: summary, kind: "empty" }
        : { artifact: summary, contentId: content.id, ...choice };
    }
    const resolved = resolveEditors({
      editors: await editors(),
      entryMime: choice.entry.mime,
      preferences: await preferences.all(),
      type: artifact.type,
    });
    return {
      artifact: summary,
      contentId: content.id,
      entry: choice.entry,
      kind: "editors",
      ...resolved,
    };
  }

  return {
    async create({ name }) {
      const path = markdownFileName(name);
      const created = await files.create({
        actor: { kind: "user" },
        bytes: new TextEncoder().encode(`# ${name}\n`),
        mime: MARKDOWN_MIME,
        name,
        path,
      });
      if (created.kind !== "created") {
        throw new ArtifactOpenError("CONFLICT", created.reason);
      }
      return { id: created.artifactId };
    },

    async list() {
      const summaries: ArtifactSummary[] = [];
      let cursor: ArtifactCursor | undefined;
      do {
        const page = await artifacts.list(cursor ? { cursor } : {});
        for (const artifact of page.items) {
          if (isProductArtifact(artifact)) {
            summaries.push(summarize(artifact));
          }
        }
        cursor = page.nextCursor;
      } while (cursor);
      return summaries.sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt)
      );
    },

    async open(input) {
      const resolved = await resolve({ entry: input.entry, id: input.id });
      if (
        resolved.kind !== "editors" ||
        resolved.contentId !== input.contentId
      ) {
        throw new ArtifactOpenError(
          "CONFLICT",
          "This artifact changed while opening it. Open it again."
        );
      }
      const chosen = (found: { moduleId: string; view: string }) =>
        found.moduleId === input.moduleId && found.view === input.view;
      const editor = resolved.candidates.find(chosen);
      const registration = (await editors()).find(chosen);
      if (!(editor && registration)) {
        throw new ArtifactOpenError(
          "CONFLICT",
          "That editor no longer opens this file. Open it again."
        );
      }
      if (resolved.candidates.length > 1) {
        await preferences.remember(resolved.mime, editor);
      }
      const contentId =
        editor.mode === "write"
          ? ((await files.working(resolved.artifact.id)) ?? resolved.contentId)
          : resolved.contentId;
      const binding = bindings.open({
        artifactId: resolved.artifact.id,
        contentId,
        entry: resolved.entry.path,
        installationId: moduleInstallationId(editor.moduleId),
        mode: editor.mode,
        moduleId: editor.moduleId,
        release: registration.release,
        view: editor.view,
      });
      return {
        artifactId: resolved.artifact.id,
        binding: binding.id,
        contentId,
        entry: resolved.entry.path,
        mode: editor.mode,
        moduleId: editor.moduleId,
        view: editor.view,
      };
    },

    resolve,

    async thumbnail({ id }) {
      const { content } = await load(id);
      if (!isUsableContent(content)) {
        return null;
      }
      const path = thumbnailPath(content);
      const node = path === null ? undefined : content.tree[path];
      if (!(path !== null && node?.type === "file")) {
        return null;
      }
      const bytes = await readBounded(artifacts, content, path);
      return bytes
        ? {
            url: `data:${node.mime};base64,${Buffer.from(bytes).toString("base64")}`,
          }
        : null;
    },
  };
}
