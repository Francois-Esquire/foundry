import type {
  AnnotationDocument,
  ShareResult,
} from "../../lib/annotations/model.ts";
import {
  decodeShare,
  encodeShare,
  NOTES_PARAM,
  type SharedDocument,
} from "../../lib/annotations/share.ts";
import { createAnchors } from "./anchors.ts";
import { mountEditor } from "./editor.ts";
import {
  isKnownLink,
  loadDocument,
  loadPrevious,
  rememberLink,
  type StorageResult,
  saveDocument,
  savePrevious,
} from "./storage.ts";
import { createTextAnchors } from "./text-anchors.ts";
import { createUrlState } from "./url-state.ts";

let dispose: (() => void) | undefined;
let generation = 0;

/**
 * A shared snapshot shown without replacing this browser's notes. The first
 * edit keeps `previous` as the restorable copy, then saves the snapshot locally.
 */
interface OpenedLink {
  payload: string;
  previous: AnnotationDocument | null;
}

function notesIn(url: string): string | null {
  return new URL(url).searchParams.get(NOTES_PARAM);
}

function sameDocument(a: AnnotationDocument, b: AnnotationDocument): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface StartingPoint {
  document: AnnotationDocument;
  error: boolean;
  message: string;
  opened: OpenedLink | null;
  /** This browser's own history entry, carrying an older copy than local storage. */
  staleUrl: boolean;
}

/**
 * Choose the document a page view starts with. A payload this browser saved
 * belongs to its own history (Back, a heading entry, reload): the local copy
 * is at least as new, so it wins. Any other valid payload is a shared snapshot.
 */
function startingPoint(
  pathname: string,
  href: string,
  local: StorageResult,
  incoming: SharedDocument
): StartingPoint {
  const payload = incoming.status === "valid" ? notesIn(href) : null;
  if (payload === null || !incoming.document) {
    const invalid = incoming.status === "invalid";
    return {
      document: local.document,
      error:
        invalid ||
        local.status === "unreadable" ||
        local.status === "unavailable",
      message: invalid ? incoming.message : local.message,
      opened: null,
      staleUrl: false,
    };
  }
  const same = sameDocument(local.document, incoming.document);
  if (local.status === "restored" && (same || isKnownLink(pathname, payload))) {
    if (same) {
      // This snapshot already is the local document. Record it before later
      // edits so its heading/history entries cannot be mistaken for imports.
      rememberLink(pathname, payload);
    }
    return {
      document: local.document,
      error: false,
      message: local.message,
      opened: null,
      staleUrl: !same,
    };
  }
  const previous =
    local.status === "restored" && local.document.marks.length > 0
      ? local.document
      : null;
  return {
    document: incoming.document,
    error: false,
    message: previous
      ? `${incoming.message} Editing keeps your earlier notes on this page as a previous copy.`
      : incoming.message,
    opened: { payload, previous },
    staleUrl: false,
  };
}

async function mountAnnotations(notice?: string): Promise<void> {
  generation += 1;
  const current = generation;
  dispose?.();
  dispose = undefined;
  const article = document.querySelector<HTMLElement>(
    "#blume-content > article"
  );
  const status = document.querySelector<HTMLElement>(
    "[data-annotation-storage]"
  );
  if (!(article && status)) {
    return;
  }
  const storageStatus = status;
  const { href, pathname } = window.location;
  const local = loadDocument(pathname);
  const incoming = await decodeShare(href);
  if (
    current !== generation ||
    !article.isConnected ||
    window.location.pathname !== pathname
  ) {
    return;
  }
  const start = startingPoint(pathname, href, local, incoming);
  let { opened } = start;
  let latest = start.document;
  // True when local storage holds the document on screen, so links it emits are ours.
  let localIsCurrent = !opened && local.status !== "unavailable";
  let localError = start.error;
  let localMessage = notice ?? start.message;
  const previousPosition = article.style.position;
  article.style.position = "relative";
  const host = document.createElement("div");
  host.className = "annotation-host";
  host.dataset.annotationHost = "";
  Object.assign(host.style, {
    inset: "0",
    pointerEvents: "none",
    position: "absolute",
    zIndex: "20",
  });
  article.append(host);
  const anchors = createAnchors(article, host);
  const textAnchors = createTextAnchors(article, host);
  const saveStatus = document.createElement("span");
  saveStatus.className = "annotation-status annotation-save-status";
  saveStatus.setAttribute("role", "status");

  function showStatus(message: string, error = false): void {
    storageStatus.textContent = message;
    saveStatus.textContent = message;
    saveStatus.dataset.error = String(error);
  }
  showStatus(localMessage, localError);
  const urlState = createUrlState({
    encode: encodeShare,
    onResult: (result) => {
      showStatus(
        `${localMessage} ${result.message}`,
        !result.url || localError
      );
    },
    readUrl: () => window.location.href,
    replace: (url) => {
      window.history.replaceState(window.history.state, "", url);
      const notes = notesIn(url);
      if (notes !== null && localIsCurrent) {
        rememberLink(pathname, notes);
      }
    },
  });

  function save(document: AnnotationDocument): void {
    latest = document;
    let kept = false;
    if (opened?.previous) {
      if (!savePrevious(pathname, opened.previous)) {
        localIsCurrent = false;
        localError = true;
        localMessage =
          "These edits are not saved in this browser because your earlier notes could not be kept. The page address holds the edited link.";
        showStatus(localMessage, true);
        urlState.schedule(document);
        return;
      }
      opened.previous = null;
      kept = true;
    }
    const saved = saveDocument(pathname, document);
    localIsCurrent = saved.saved;
    localError = !saved.saved;
    localMessage = saved.message;
    if (opened && saved.saved) {
      // The snapshot is now this browser's copy, so revisiting its URL shows local notes.
      rememberLink(pathname, opened.payload);
      opened = null;
      if (kept) {
        localMessage +=
          " Your earlier notes can be restored from the annotation menu.";
      }
    }
    showStatus(localMessage, localError);
    urlState.schedule(document);
  }

  function restorePrevious(): void {
    const previous = loadPrevious(pathname);
    if (!(previous && savePrevious(pathname, latest))) {
      showStatus("Previous notes could not be restored.", true);
      return;
    }
    if (!saveDocument(pathname, previous).saved) {
      savePrevious(pathname, previous);
      showStatus(
        "Previous notes could not be restored. Your current notes are unchanged.",
        true
      );
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.delete(NOTES_PARAM);
    window.history.replaceState(window.history.state, "", url.href);
    startAnnotations(
      "Previous notes restored. The notes they replaced are now the previous copy."
    );
  }

  const disposeEditor = mountEditor(host, {
    anchorAt: anchors.anchorAt,
    initial: start.document,
    onChange: save,
    onShare: async (document): Promise<ShareResult> => {
      const update = await urlState.update(document);
      if (update.status === "superseded") {
        return {
          bytes: 0,
          message:
            "The annotations changed while the link was being created. Choose Share again to copy the latest link.",
          qrReady: false,
        };
      }
      if (update.status === "stopped") {
        return {
          bytes: 0,
          message: "The page changed. Share again from the current page.",
          qrReady: false,
        };
      }
      const { result } = update;
      if (result.url) {
        try {
          await navigator.clipboard.writeText(result.url);
          if (current === generation) {
            return { ...result, message: `Link copied. ${result.message}` };
          }
        } catch {
          return {
            ...result,
            message: `Copy the browser address to share. ${result.message}`,
          };
        }
      }
      return result;
    },
    previous: {
      available: () =>
        opened === null && localIsCurrent && loadPrevious(pathname) !== null,
      restore: restorePrevious,
    },
    resolveAnchor: anchors.resolveAnchor,
    textAnchors,
  });
  host.querySelector(".annotation-toolbar")?.append(saveStatus);
  if (start.staleUrl) {
    // Bring this entry's address up to the notes now shown.
    urlState.schedule(start.document);
  }
  dispose = () => {
    urlState.dispose();
    disposeEditor();
    textAnchors.dispose();
    anchors.dispose();
    host.remove();
    article.style.position = previousPosition;
  };
}

function unmountAnnotations(): void {
  generation += 1;
  dispose?.();
  dispose = undefined;
}

async function startAnnotations(notice?: string): Promise<void> {
  const attempt = generation + 1;
  try {
    await mountAnnotations(notice);
  } catch {
    if (attempt === generation) {
      const status = document.querySelector<HTMLElement>(
        "[data-annotation-storage]"
      );
      if (status) {
        status.textContent =
          "Annotation tools could not load. Reload the page to try again.";
      }
    }
  }
}

startAnnotations();
document.addEventListener("astro:page-load", () => startAnnotations());
document.addEventListener("astro:before-swap", unmountAnnotations);
window.addEventListener("popstate", () => startAnnotations());
