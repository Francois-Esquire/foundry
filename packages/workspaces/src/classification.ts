import type { FileKind } from "./workspace";

export interface FileClassification {
  readonly extension: string | null;
  readonly kind: FileKind;
  readonly mimeType: string | null;
  readonly name: string;
}

/**
 * The versioned extension table. Deterministic and deliberately small: an
 * unknown extension is `other` with a null media type, never a reason to open
 * the file or invoke analysis.
 */
export const CLASSIFICATION_VERSION = 1;

const BY_EXTENSION: Readonly<
  Record<string, { readonly mimeType: string; readonly kind: FileKind }>
> = {
  css: { kind: "code", mimeType: "text/css" },
  csv: { kind: "data", mimeType: "text/csv" },
  env: { kind: "config", mimeType: "text/plain" },
  gif: { kind: "image", mimeType: "image/gif" },
  go: { kind: "code", mimeType: "text/x-go" },
  html: { kind: "code", mimeType: "text/html" },
  ini: { kind: "config", mimeType: "text/plain" },
  jpeg: { kind: "image", mimeType: "image/jpeg" },
  jpg: { kind: "image", mimeType: "image/jpeg" },
  js: { kind: "code", mimeType: "text/javascript" },

  json: { kind: "data", mimeType: "application/json" },
  jsx: { kind: "code", mimeType: "text/javascript" },

  md: { kind: "document", mimeType: "text/markdown" },
  mdx: { kind: "document", mimeType: "text/markdown" },

  mp3: { kind: "audio", mimeType: "audio/mpeg" },
  mp4: { kind: "video", mimeType: "video/mp4" },
  pdf: { kind: "document", mimeType: "application/pdf" },

  png: { kind: "image", mimeType: "image/png" },
  py: { kind: "code", mimeType: "text/x-python" },
  rs: { kind: "code", mimeType: "text/x-rust" },
  sh: { kind: "code", mimeType: "application/x-sh" },
  sql: { kind: "code", mimeType: "application/sql" },
  svg: { kind: "image", mimeType: "image/svg+xml" },
  toml: { kind: "config", mimeType: "application/toml" },
  ts: { kind: "code", mimeType: "text/typescript" },
  tsx: { kind: "code", mimeType: "text/typescript" },
  txt: { kind: "document", mimeType: "text/plain" },
  wav: { kind: "audio", mimeType: "audio/wav" },
  webm: { kind: "video", mimeType: "video/webm" },
  webp: { kind: "image", mimeType: "image/webp" },
  xml: { kind: "data", mimeType: "application/xml" },

  yaml: { kind: "config", mimeType: "application/yaml" },
  yml: { kind: "config", mimeType: "application/yaml" },
};

export function classifyFile(relativePath: string): FileClassification {
  const name = relativePath.split("/").at(-1) ?? relativePath;
  const extension = extensionOf(name);
  const known = extension === null ? undefined : BY_EXTENSION[extension];
  return {
    extension,
    kind: known?.kind ?? "other",
    mimeType: known?.mimeType ?? null,
    name,
  };
}

/** Lowercased and dotless, or null for a dotfile or a name without one. */
function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) {
    return null;
  }
  return name.slice(dot + 1).toLowerCase();
}
