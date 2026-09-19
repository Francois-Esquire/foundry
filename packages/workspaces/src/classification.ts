import type { FileClassification, FileKind } from "./types";

/**
 * The versioned extension table. Deterministic and deliberately small: an
 * unknown extension is `other` with a null media type, never a reason to open
 * the file or invoke analysis.
 */
export const CLASSIFICATION_VERSION = 1;

const BY_EXTENSION: Readonly<
  Record<string, { readonly mime: string; readonly kind: FileKind }>
> = {
  css: { kind: "code", mime: "text/css" },
  csv: { kind: "data", mime: "text/csv" },
  env: { kind: "config", mime: "text/plain" },
  gif: { kind: "image", mime: "image/gif" },
  go: { kind: "code", mime: "text/x-go" },
  html: { kind: "code", mime: "text/html" },
  ini: { kind: "config", mime: "text/plain" },
  jpeg: { kind: "image", mime: "image/jpeg" },
  jpg: { kind: "image", mime: "image/jpeg" },
  js: { kind: "code", mime: "text/javascript" },

  json: { kind: "data", mime: "application/json" },
  jsx: { kind: "code", mime: "text/javascript" },

  md: { kind: "document", mime: "text/markdown" },
  mdx: { kind: "document", mime: "text/markdown" },

  mp3: { kind: "audio", mime: "audio/mpeg" },
  mp4: { kind: "video", mime: "video/mp4" },
  pdf: { kind: "document", mime: "application/pdf" },

  png: { kind: "image", mime: "image/png" },
  py: { kind: "code", mime: "text/x-python" },
  rs: { kind: "code", mime: "text/x-rust" },
  sh: { kind: "code", mime: "application/x-sh" },
  sql: { kind: "code", mime: "application/sql" },
  svg: { kind: "image", mime: "image/svg+xml" },
  toml: { kind: "config", mime: "application/toml" },
  ts: { kind: "code", mime: "text/typescript" },
  tsx: { kind: "code", mime: "text/typescript" },
  txt: { kind: "document", mime: "text/plain" },
  wav: { kind: "audio", mime: "audio/wav" },
  webm: { kind: "video", mime: "video/webm" },
  webp: { kind: "image", mime: "image/webp" },
  xml: { kind: "data", mime: "application/xml" },

  yaml: { kind: "config", mime: "application/yaml" },
  yml: { kind: "config", mime: "application/yaml" },
};

export function classifyFile(relativePath: string): FileClassification {
  const name = relativePath.split("/").at(-1) ?? relativePath;
  const extension = extensionOf(name);
  const known = extension === null ? undefined : BY_EXTENSION[extension];
  return {
    extension,
    kind: known?.kind ?? "other",
    mime: known?.mime ?? null,
    name,
  };
}

function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) {
    return null;
  }
  return name.slice(dot + 1).toLowerCase();
}
