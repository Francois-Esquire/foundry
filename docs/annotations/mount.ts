import { createAnchors } from "./anchors.ts";
import { mountEditor } from "./editor.ts";
import type { ShareResult } from "./model.ts";
import { decodeShare, encodeShare } from "./share.ts";
import { loadDocument, saveDocument } from "./storage.ts";
import { createTextAnchors } from "./text-anchors.ts";
import { createUrlState } from "./url-state.ts";

let dispose: (() => void) | undefined;
let generation = 0;

async function mountAnnotations(): Promise<void> {
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
  const { pathname } = window.location;
  const local = loadDocument(pathname);
  const incoming = await decodeShare(window.location.href);
  if (
    current !== generation ||
    !article.isConnected ||
    window.location.pathname !== pathname
  ) {
    return;
  }
  const initial =
    incoming.status === "valid" && incoming.document
      ? incoming.document
      : local.document;
  const initialMessage =
    incoming.status === "absent" ? local.message : incoming.message;
  status.textContent = initialMessage;
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
  let localMessage = initialMessage;

  function showStatus(message: string, error = false): void {
    storageStatus.textContent = message;
    saveStatus.textContent = message;
    saveStatus.dataset.error = String(error);
  }
  showStatus(
    initialMessage,
    incoming.status === "invalid" ||
      initialMessage.includes("could not") ||
      initialMessage.includes("unavailable")
  );
  const urlState = createUrlState({
    encode: encodeShare,
    onResult: (result) => {
      showStatus(
        `${localMessage} ${result.message}`,
        !result.url || localMessage.includes("could not")
      );
    },
    readUrl: () => window.location.href,
    replace: (url) =>
      window.history.replaceState(window.history.state, "", url),
  });
  const disposeEditor = mountEditor(host, {
    anchorAt: anchors.anchorAt,
    initial,
    onChange: (document) => {
      localMessage = saveDocument(pathname, document);
      showStatus(localMessage, localMessage.includes("could not"));
      urlState.schedule(document);
    },
    onShare: async (document): Promise<ShareResult> => {
      const result = await urlState.update(document);
      if (!result) {
        return {
          bytes: 0,
          message: "The page changed. Share again from the current page.",
          qrReady: false,
        };
      }
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
    resolveAnchor: anchors.resolveAnchor,
    textAnchors,
  });
  host.querySelector(".annotation-toolbar")?.append(saveStatus);
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

function startAnnotations(): void {
  const attempt = generation + 1;
  mountAnnotations().catch(() => {
    if (attempt === generation) {
      const status = document.querySelector<HTMLElement>(
        "[data-annotation-storage]"
      );
      if (status) {
        status.textContent =
          "Annotation tools could not load. Reload the page to try again.";
      }
    }
  });
}

startAnnotations();
document.addEventListener("astro:page-load", startAnnotations);
document.addEventListener("astro:before-swap", unmountAnnotations);
window.addEventListener("popstate", startAnnotations);
