const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const ICONS: Record<string, string> = {
  "Add text": "M4 5h16M12 5v15M8 20h8M4 5v3M20 5v3",
  "Annotation menu": "M5 6h14M5 12h14M5 18h14",
  Arrow: "M4 20 20 4M10 4h10v10",
  Browse: "m5 3 14 9-7 1-3 7Z",
  Comment: "M4 4h16v12H9l-5 4Z",
  Draw: "m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15Z",
  "Hide annotations":
    "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6",
  Highlight: "m5 17 8-12 6 4-8 11-6-3ZM4 21h14",
  "Share annotations": "M12 16V3m-4 4 4-4 4 4M5 12v8h14v-8",
  "Show annotations":
    "m3 3 18 18M9 5a12 12 0 0 1 13 7 19 19 0 0 1-4 4M6 6a19 19 0 0 0-4 6s4 7 10 7a13 13 0 0 0 4-1",
  Underline: "M6 4v7a6 6 0 0 0 12 0V4M4 21h16",
  Undo: "m9 5-5 5 5 5M4 10h10a6 6 0 0 1 0 12",
};

export function svgElement(name: string): SVGElement {
  return document.createElementNS(SVG_NAMESPACE, name);
}

export function labelButton(button: HTMLButtonElement, label: string) {
  button.setAttribute("aria-label", label);
  button.dataset.tooltip = label;
  button.replaceChildren();
  const shape = ICONS[label];
  if (!shape) {
    button.textContent = label;
    return;
  }
  const icon = svgElement("svg");
  for (const [key, value] of Object.entries({
    "aria-hidden": "true",
    fill: "none",
    stroke: "currentColor",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "stroke-width": "1.7",
    viewBox: "0 0 24 24",
  })) {
    icon.setAttribute(key, value);
  }
  const path = svgElement("path");
  path.setAttribute("d", shape);
  icon.append(path);
  button.append(icon);
}

export function actionButton(label: string, action: () => void) {
  const button = document.createElement("button");
  button.type = "button";
  labelButton(button, label);
  button.addEventListener("click", action);
  return button;
}

/** Popovers use viewport coordinates so a note near the article bottom remains usable. */
export function placePanel(
  panel: HTMLElement,
  point?: { x: number; y: number }
) {
  panel.style.left = `${Math.max(8, Math.min(point?.x ?? window.innerWidth - 360, window.innerWidth - 336))}px`;
  panel.style.top = `${Math.max(72, Math.min(point?.y ?? 100, window.innerHeight - 290))}px`;
}

export function createEditorChrome() {
  const surface = svgElement("svg");
  surface.classList.add("annotation-surface");
  surface.setAttribute("role", "group");
  surface.setAttribute("aria-label", "Documentation annotations");
  surface.setAttribute("tabindex", "0");
  surface.setAttribute(
    "aria-description",
    "Select text for highlights and comments. Choose Add text then press Enter to place a note. Escape returns to Browse."
  );
  const toolbar = document.createElement("div");
  toolbar.className = "annotation-toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Annotate documentation");
  toolbar.setAttribute("aria-orientation", "vertical");
  const status = document.createElement("span");
  status.className = "annotation-status";
  status.setAttribute("role", "status");
  const feedback = document.createElement("p");
  feedback.className = "annotation-feedback";
  feedback.hidden = true;
  feedback.setAttribute("role", "status");
  const contextual = document.createElement("div");
  contextual.className = "annotation-selection-menu";
  contextual.hidden = true;
  contextual.setAttribute("role", "toolbar");
  contextual.setAttribute("aria-label", "Annotate selected text");

  return { contextual, feedback, status, surface, toolbar };
}
