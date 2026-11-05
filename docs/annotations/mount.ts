import { createAnchors } from "./anchors.ts";
import { mountEditor } from "./editor.ts";
import { loadDocument, saveDocument } from "./storage.ts";

let dispose: (() => void) | undefined;

function mountAnnotations(): void {
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

  const { pathname } = window.location;
  const initial = loadDocument(pathname);
  status.textContent = initial.message;
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
  const saveStatus = document.createElement("span");
  saveStatus.className = "annotation-status annotation-save-status";
  saveStatus.setAttribute("role", "status");
  saveStatus.textContent = initial.message;
  saveStatus.dataset.error = String(
    initial.message.includes("unavailable") ||
      initial.message.includes("could not")
  );
  const disposeEditor = mountEditor(host, {
    anchorAt: anchors.anchorAt,
    initial: initial.document,
    onChange: (document) => {
      const message = saveDocument(pathname, document);
      status.textContent = message;
      saveStatus.textContent = message;
      saveStatus.dataset.error = String(message.includes("could not"));
    },
    resolveAnchor: anchors.resolveAnchor,
  });
  host.querySelector(".annotation-toolbar")?.append(saveStatus);
  dispose = () => {
    disposeEditor();
    anchors.dispose();
    host.remove();
    article.style.position = previousPosition;
  };
}

mountAnnotations();
document.addEventListener("astro:page-load", mountAnnotations);
document.addEventListener("astro:before-swap", () => {
  dispose?.();
  dispose = undefined;
});
