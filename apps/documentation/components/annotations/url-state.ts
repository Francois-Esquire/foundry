import type {
  AnnotationDocument,
  ShareResult,
} from "../../lib/annotations/model.ts";
import {
  MAX_URL_BYTES,
  NOTES_PARAM,
  QR_TARGET_BYTES,
  shareReadyMessage,
} from "../../lib/annotations/share.ts";

interface UrlStateOptions {
  encode: (
    document: AnnotationDocument,
    baseUrl: string
  ) => Promise<ShareResult>;
  onResult: (result: ShareResult) => void;
  readUrl: () => string;
  replace: (url: string) => void;
}

/**
 * `done` wrote the address. `superseded` means a newer edit replaced this
 * document while it encoded; `stopped` means disposal or a different page.
 * Neither of the latter changes the address.
 */
export type UrlUpdate =
  | { result: ShareResult; status: "done" }
  | { status: "stopped" }
  | { status: "superseded" };

/** Serialize the latest edit only, preserving navigation and unrelated URL state. */
export function createUrlState(options: UrlStateOptions) {
  let revision = 0;
  let disposed = false;
  let pending: ReturnType<typeof setTimeout> | undefined;

  async function update(document: AnnotationDocument): Promise<UrlUpdate> {
    clearTimeout(pending);
    revision += 1;
    const request = revision;
    const base = options.readUrl();
    let result: ShareResult;
    try {
      result = await options.encode(document, base);
    } catch {
      result = {
        bytes: 0,
        message:
          "A share link could not be created. Notes remain saved locally.",
        qrReady: false,
      };
    }
    const current = new URL(options.readUrl());
    if (disposed || current.pathname !== new URL(base).pathname) {
      return { status: "stopped" };
    }
    if (request !== revision) {
      return { status: "superseded" };
    }
    const notes = result.url
      ? new URL(result.url).searchParams.get(NOTES_PARAM)
      : null;
    if (notes === null) {
      current.searchParams.delete(NOTES_PARAM);
    } else {
      current.searchParams.set(NOTES_PARAM, notes);
    }
    const url = current.href;
    if (url !== options.readUrl()) {
      options.replace(url);
    }
    const completed = {
      ...result,
      bytes: result.url ? new TextEncoder().encode(url).length : result.bytes,
      url: result.url ? url : undefined,
    };
    // A fragment/query can grow while encoding, so recheck the complete URL.
    if (completed.url && completed.bytes > MAX_URL_BYTES) {
      current.searchParams.delete(NOTES_PARAM);
      options.replace(current.href);
      completed.url = undefined;
      completed.qrReady = false;
      completed.message =
        "This page address is too long to share. Notes remain saved locally.";
    } else if (completed.url) {
      completed.qrReady = completed.bytes <= QR_TARGET_BYTES;
      completed.message = shareReadyMessage(completed.bytes);
    }
    options.onResult(completed);
    return { result: completed, status: "done" };
  }

  function schedule(document: AnnotationDocument): void {
    clearTimeout(pending);
    revision += 1;
    pending = setTimeout(() => {
      update(document);
    }, 180);
  }

  function dispose(): void {
    disposed = true;
    revision += 1;
    clearTimeout(pending);
  }

  return { dispose, schedule, update };
}
