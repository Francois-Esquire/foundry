import type { EditorOpenRequest } from "~/shared/artifacts";

/**
 * The Module app route for an opened entry: the editor View, opened with
 * its host-owned binding. The binding is the only thing the View receives;
 * its Program resolves it through `works.editors.binding`.
 */
export function editorPath(request: EditorOpenRequest): string {
  const search = new URLSearchParams({
    binding: request.binding,
    view: request.view,
  });
  return `/m/${encodeURIComponent(request.moduleId)}?${search}`;
}

/** A View's URL carrying the editor binding it was opened with. */
export function boundViewUrl(
  origin: string,
  path: string,
  binding: string | null
): string {
  if (!binding) {
    return `${origin}${path}`;
  }
  const url = new URL(path, origin);
  url.searchParams.set("binding", binding);
  return `${origin}${url.pathname}${url.search}`;
}
