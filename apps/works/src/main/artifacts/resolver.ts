import { type Content, rootPath } from "@foundry/artifacts";
import { type ArtifactBase, createRegistry } from "@foundry/artifacts/registry";
import type {
  ArtifactEntryOption,
  EditorCandidate,
  EditorMatch,
} from "~/shared/artifacts";

/** An editor a released Module declares: one View, the MIME types it opens. */
export interface EditorRegistration extends EditorCandidate {
  readonly mimeTypes: readonly string[];
  /** The release (Content) declaring it, which the editor runs. */
  readonly release: string;
}

/** The remembered editor for one MIME type. */
export interface EditorPreference {
  readonly moduleId: string;
  readonly view: string;
}

export interface EditorResolution {
  readonly candidates: EditorCandidate[];
  readonly match: EditorMatch;
  /** The MIME type matched on; a choice is remembered under it. */
  readonly mime: string;
  readonly preferred: EditorCandidate | null;
}

// Only classifies MIME families; nothing is handled here.
const registry = createRegistry<null>({ fallback: null });

/** `type/subtype`, lowercase, without parameters, as editors declare them. */
function normalizeMime(mime: string): string {
  return (mime.split(";", 1)[0] ?? "").trim().toLowerCase();
}

function family(mime: string): ArtifactBase | null {
  return registry.resolve({ artifact: { type: mime } }).base;
}

function candidate(editor: EditorRegistration): EditorCandidate {
  return {
    mode: editor.mode,
    moduleId: editor.moduleId,
    moduleName: editor.moduleName,
    view: editor.view,
    viewTitle: editor.viewTitle,
  };
}

function byName(left: EditorCandidate, right: EditorCandidate): number {
  return (
    left.moduleName.localeCompare(right.moduleName) ||
    left.moduleId.localeCompare(right.moduleId) ||
    left.view.localeCompare(right.view)
  );
}

function declaring(
  editors: readonly EditorRegistration[],
  accepts: (mime: string) => boolean
): EditorCandidate[] {
  return editors
    .filter((editor) => editor.mimeTypes.some(accepts))
    .map(candidate)
    .sort(byName);
}

/** Each tier in precedence order: the MIME it matches on and its editors. */
function* tiers(
  type: string,
  entryMime: string | null,
  editors: readonly EditorRegistration[]
): Generator<{
  candidates: EditorCandidate[];
  match: EditorMatch;
  mime: string;
}> {
  yield {
    candidates: declaring(editors, (mime) => mime === type),
    match: "type",
    mime: type,
  };
  if (entryMime) {
    yield {
      candidates: declaring(editors, (mime) => mime === entryMime),
      match: "entry",
      mime: entryMime,
    };
  }
  // The registry's family rule: the Artifact type's, else the entry file's.
  const typeFamily = family(type);
  const familyMime = typeFamily === null ? entryMime : type;
  const base = familyMime === null ? null : family(familyMime);
  if (familyMime !== null && base !== null) {
    yield {
      candidates: declaring(editors, (mime) => family(mime) === base),
      match: "family",
      mime: familyMime,
    };
  }
}

/**
 * Which editors open an Artifact entry. Precedence: editors declaring the
 * exact Artifact type, then the entry file's exact MIME type, then any MIME
 * type in the same registry family; otherwise none (the honest fallback).
 * A remembered choice applies only while several editors match and it is
 * still one of them.
 */
export function resolveEditors(input: {
  readonly editors: readonly EditorRegistration[];
  readonly entryMime: string | null;
  readonly preferences?: Readonly<Record<string, EditorPreference>>;
  readonly type: string;
}): EditorResolution {
  const type = normalizeMime(input.type);
  const entryMime = input.entryMime ? normalizeMime(input.entryMime) : null;
  for (const tier of tiers(type, entryMime, input.editors)) {
    if (tier.candidates.length > 0) {
      const remembered = input.preferences?.[tier.mime];
      const preferred =
        tier.candidates.length > 1 && remembered
          ? (tier.candidates.find(
              (found) =>
                found.moduleId === remembered.moduleId &&
                found.view === remembered.view
            ) ?? null)
          : null;
      return { ...tier, preferred };
    }
  }
  // Nothing opens it: name the file's own type when it has one.
  return {
    candidates: [],
    match: "none",
    mime: entryMime ?? type,
    preferred: null,
  };
}

export type EntryChoice =
  | { readonly kind: "empty" }
  | { readonly entry: ArtifactEntryOption; readonly kind: "entry" }
  | { readonly entries: ArtifactEntryOption[]; readonly kind: "entries" };

function fileAt(
  content: Pick<Content, "tree">,
  path: string
): ArtifactEntryOption | null {
  const node = Object.hasOwn(content.tree, path) ? content.tree[path] : null;
  return node?.type === "file"
    ? { bytes: node.bytes, mime: node.mime, path }
    : null;
}

/**
 * The entry to open without asking: the declared `metadata.entry`, the
 * only file, or root `index.html` (the package's documented default). A
 * declared entry that is not a file is never replaced by another file.
 */
function primaryEntry(
  content: Pick<Content, "metadata" | "tree">
): ArtifactEntryOption | null {
  const path = rootPath(content);
  return path === null ? null : fileAt(content, path);
}

/**
 * The entry to open: `requested` when given (null when it is not a file),
 * else the primary entry, else every file for an explicit choice.
 */
export function chooseEntry(
  content: Pick<Content, "metadata" | "tree">,
  requested?: string
): EntryChoice | null {
  if (requested !== undefined) {
    const entry = fileAt(content, requested);
    return entry ? { entry, kind: "entry" } : null;
  }
  const primary = primaryEntry(content);
  if (primary) {
    return { entry: primary, kind: "entry" };
  }
  const entries = Object.keys(content.tree)
    .sort()
    .flatMap((path) => fileAt(content, path) ?? []);
  return entries.length === 0
    ? { kind: "empty" }
    : { entries, kind: "entries" };
}
