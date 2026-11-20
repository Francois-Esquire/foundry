import { type Content, rootPath } from "@foundry/artifacts";
import { type ArtifactBase, createRegistry } from "@foundry/artifacts/registry";
import type {
  ArtifactEntryOption,
  EditorCandidate,
  EditorMatch,
} from "~/shared/artifacts";

export interface EditorRegistration extends EditorCandidate {
  readonly mimeTypes: readonly string[];
  readonly release: string;
}

export interface EditorPreference {
  readonly moduleId: string;
  readonly view: string;
}

export interface EditorResolution {
  readonly candidates: EditorCandidate[];
  readonly match: EditorMatch;
  readonly mime: string;
  readonly preferred: EditorCandidate | null;
}

const registry = createRegistry<null>({ fallback: null });

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

function primaryEntry(
  content: Pick<Content, "metadata" | "tree">
): ArtifactEntryOption | null {
  const path = rootPath(content);
  return path === null ? null : fileAt(content, path);
}

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
