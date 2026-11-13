import { z } from "zod";
import type { ModuleSourceRevision } from "~/shared/modules";

const draftSchema = z.object({
  expected: z.object({
    artifactId: z.string(),
    contentId: z.string(),
    updatedAt: z.iso.datetime(),
  }),
  source: z.record(z.string(), z.string()),
});

export function readModuleDraft(id: string) {
  const text = window.localStorage.getItem(`module-draft:${id}`);
  if (!text) {
    return null;
  }
  return draftSchema.parse(JSON.parse(text));
}

export function writeModuleDraft(
  id: string,
  source: Record<string, string>,
  expected: ModuleSourceRevision
) {
  window.localStorage.setItem(
    `module-draft:${id}`,
    JSON.stringify({ expected, source })
  );
}

export function clearModuleDraft(id: string) {
  window.localStorage.removeItem(`module-draft:${id}`);
}

export function sameSource(
  left: Record<string, string>,
  right: Record<string, string>
) {
  return (
    Object.keys(left).length === Object.keys(right).length &&
    Object.entries(left).every(([path, text]) => right[path] === text)
  );
}

/**
 * The Draft moved onto newly saved source: each file still as `before`
 * takes the saved version (deleted when the save removed it); a file
 * changed in the Draft since `before` keeps the Draft's version.
 */
export function rebaseSource(
  before: Readonly<Record<string, string>>,
  draft: Readonly<Record<string, string>>,
  saved: Readonly<Record<string, string>>
): Record<string, string> {
  const original = new Map(Object.entries(before));
  const edited = new Map(Object.entries(draft));
  const published = new Map(Object.entries(saved));
  const rebased = new Map<string, string>();
  for (const path of new Set([
    ...original.keys(),
    ...edited.keys(),
    ...published.keys(),
  ])) {
    const untouched = edited.get(path) === original.get(path);
    const text = untouched ? published.get(path) : edited.get(path);
    if (text !== undefined) {
      rebased.set(path, text);
    }
  }
  return Object.fromEntries(rebased);
}
