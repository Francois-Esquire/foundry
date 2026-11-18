import type { EditorOpenRequest } from "~/shared/artifacts";

export function editorPath(request: EditorOpenRequest): string {
  const search = new URLSearchParams({
    binding: request.binding,
    release: request.release,
    view: request.view,
  });
  return `/m/${encodeURIComponent(request.moduleId)}?${search}`;
}

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
