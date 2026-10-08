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
