import { decodeDocument, encodeDocument } from "../../lib/annotations/codec.ts";
import type { AnnotationDocument } from "../../lib/annotations/model.ts";

const MAX_KNOWN_LINKS = 200;
const VIEW_DELIMITER = /[?#]/;
const TRAILING_SLASHES = /\/+$/;

function emptyDocument(): AnnotationDocument {
  return { marks: [], version: 1 };
}

function pagePath(pathname: string): string {
  const path = pathname.split(VIEW_DELIMITER, 1)[0] || "/";
  return path.replace(TRAILING_SLASHES, "") || "/";
}

/** Queries and fragments select a view of the same document. */
export function storageKey(pathname: string): string {
  return `foundry:annotations:v1:${pagePath(pathname)}`;
}

function previousKey(pathname: string): string {
  return `foundry:annotations-previous:v1:${pagePath(pathname)}`;
}

function linksKey(pathname: string): string {
  return `foundry:annotations-links:v1:${pagePath(pathname)}`;
}

type LoadStatus = "empty" | "restored" | "unreadable" | "unavailable";

export interface StorageResult {
  document: AnnotationDocument;
  message: string;
  status: LoadStatus;
}

export interface SaveResult {
  message: string;
  saved: boolean;
}

export function loadDocument(pathname: string): StorageResult {
  try {
    const source = window.localStorage.getItem(storageKey(pathname));
    if (source === null) {
      return {
        document: emptyDocument(),
        message: "Notes stay in this browser on this page.",
        status: "empty",
      };
    }
    const document = decodeDocument(source);
    return document
      ? {
          document,
          message: "Notes restored from this browser.",
          status: "restored",
        }
      : {
          document: emptyDocument(),
          message:
            "Saved notes could not be read. New notes will replace them.",
          status: "unreadable",
        };
  } catch {
    return {
      document: emptyDocument(),
      message:
        "Browser storage is unavailable. Notes last until you leave this page.",
      status: "unavailable",
    };
  }
}

export function saveDocument(
  pathname: string,
  document: AnnotationDocument
): SaveResult {
  try {
    window.localStorage.setItem(storageKey(pathname), encodeDocument(document));
    return { message: "Notes saved in this browser.", saved: true };
  } catch {
    return {
      message: "Notes could not be saved. Keep this page open to retain them.",
      saved: false,
    };
  }
}

/** The one copy kept when an opened share link replaces this page's notes. */
export function loadPrevious(pathname: string): AnnotationDocument | null {
  try {
    const source = window.localStorage.getItem(previousKey(pathname));
    return source === null ? null : decodeDocument(source);
  } catch {
    return null;
  }
}

export function savePrevious(
  pathname: string,
  document: AnnotationDocument
): boolean {
  try {
    window.localStorage.setItem(
      previousKey(pathname),
      encodeDocument(document)
    );
    return true;
  } catch {
    return false;
  }
}

function digest(value: string): string {
  let first = 0;
  let second = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = (first * 31 + code) % 4_294_967_291;
    second = (second * 131 + code) % 4_294_967_279;
  }
  return `${first.toString(36)}.${second.toString(36)}`;
}

function knownLinks(pathname: string): string[] {
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(linksKey(pathname)) ?? "[]"
    );
    return Array.isArray(value)
      ? value
          .filter((entry): entry is string => typeof entry === "string")
          .slice(-MAX_KNOWN_LINKS)
      : [];
  } catch {
    return [];
  }
}

/**
 * Record a `notes` payload whose document this browser has saved locally.
 * A later visit to a URL carrying it selects the current local copy.
 */
export function rememberLink(pathname: string, payload: string): void {
  const value = digest(payload);
  const links = knownLinks(pathname).filter((entry) => entry !== value);
  links.push(value);
  try {
    window.localStorage.setItem(
      linksKey(pathname),
      JSON.stringify(links.slice(-MAX_KNOWN_LINKS))
    );
  } catch {
    // Without a record, the link is treated as shared and never overwrites local notes silently.
  }
}

export function isKnownLink(pathname: string, payload: string): boolean {
  return knownLinks(pathname).includes(digest(payload));
}
