import type { AnnotationDocument, ShareResult } from "./model.ts";

interface UrlStateOptions {
  encode: (
    document: AnnotationDocument,
    baseUrl: string
  ) => Promise<ShareResult>;
  onResult: (result: ShareResult) => void;
  readUrl: () => string;
  replace: (url: string) => void;
}

/** Serialize the latest edit only, preserving navigation and unrelated URL state. */
export function createUrlState(options: UrlStateOptions) {
  let revision = 0;
  let disposed = false;
  let pending: ReturnType<typeof setTimeout> | undefined;

  async function update(
    document: AnnotationDocument
  ): Promise<ShareResult | null> {
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
    if (
      disposed ||
      request !== revision ||
      current.pathname !== new URL(base).pathname
    ) {
      return null;
    }
    const notes = result.url
      ? new URL(result.url).searchParams.get("notes")
      : null;
    if (notes === null) {
      current.searchParams.delete("notes");
    } else {
      current.searchParams.set("notes", notes);
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
    if (completed.url && completed.bytes > 8000) {
      current.searchParams.delete("notes");
      options.replace(current.href);
      completed.url = undefined;
      completed.qrReady = false;
      completed.message =
        "This page address is too long to share. Notes remain saved locally.";
    } else if (completed.url) {
      completed.qrReady = completed.bytes <= 2000;
      completed.message = completed.qrReady
        ? `Share link ready (${completed.bytes.toLocaleString()} bytes, within the 2,000-byte QR target).`
        : `Share link ready (${completed.bytes.toLocaleString()} bytes). It exceeds the 2,000-byte QR target.`;
    }
    options.onResult(completed);
    return completed;
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
