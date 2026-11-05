import { fitStroke } from "./geometry.ts";
import type { Anchor, AnnotationDocument, Mark, Point } from "./model.ts";

type Tool = "browse" | "draw" | "text";
interface EditorOptions {
  anchorAt: (x: number, y: number) => Anchor;
  initial: AnnotationDocument;
  onChange: (document: AnnotationDocument) => void;
  resolveAnchor: (anchor: Anchor) => Point | null;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

function svgElement(name: "svg" | "path" | "text" | "tspan") {
  return document.createElementNS(SVG_NAMESPACE, name);
}

const TOOL_ICONS: Record<string, string> = {
  "Add text": "M4 5h16M12 5v15M8 20h8M4 5v3M20 5v3",
  Browse: "m5 3 14 9-7 1-3 7Z",
  "Clear annotations": "M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6",
  Draw: "m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15Z",
  Undo: "M9 5 4 10l5 5M4 10h10a6 6 0 0 1 0 12",
};

function actionButton(label: string, action: () => void) {
  const button = document.createElement("button");
  button.type = "button";
  const iconPath = TOOL_ICONS[label];
  if (iconPath) {
    button.setAttribute("aria-label", label);
    button.dataset.tooltip = label;
    const icon = svgElement("svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "1.7");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    icon.setAttribute("aria-hidden", "true");
    const path = svgElement("path");
    path.setAttribute("d", iconPath);
    icon.append(path);
    button.append(icon);
  } else {
    button.textContent = label;
  }
  button.addEventListener("click", action);
  return button;
}

function wrapNote(
  value: string,
  width: number,
  measure: (text: string) => number
) {
  const lines: string[] = [];
  for (const paragraph of value.split("\n")) {
    let line = "";
    for (const character of paragraph) {
      if (line && measure(line + character) > width) {
        const space = line.lastIndexOf(" ");
        if (space > 0) {
          lines.push(line.slice(0, space));
          line = line.slice(space + 1) + character;
        } else {
          lines.push(line);
          line = character;
        }
      } else {
        line += character;
      }
    }
    lines.push(line);
  }
  return lines;
}

function renderMark(
  mark: Mark,
  origin: Point,
  hostWidth: number,
  measure: (text: string) => number
) {
  if (mark.kind === "text") {
    const text = svgElement("text");
    const noteWidth = Math.max(1, Math.min(280, hostWidth - 16));
    const x = Math.max(8, Math.min(origin.x, hostWidth - noteWidth - 8));
    text.setAttribute("x", String(x));
    text.setAttribute("y", String(origin.y));
    text.setAttribute("fill", mark.color);
    text.setAttribute("class", "annotation-text");
    for (const [index, line] of wrapNote(
      mark.text,
      noteWidth,
      measure
    ).entries()) {
      const span = svgElement("tspan");
      span.setAttribute("x", String(x));
      span.setAttribute("dy", index === 0 ? "0" : "1.3em");
      span.textContent = line || " ";
      text.append(span);
    }
    return text;
  }
  const path = svgElement("path");
  const points = fitStroke(mark.points, origin, hostWidth).map(
    (point) => `${point.x},${point.y}`
  );
  path.setAttribute("d", `M${points.join(" L")} l0.01,0.01`);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", mark.color);
  path.setAttribute("stroke-width", "3");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  return path;
}

/** An SVG view of a versioned document; storage and anchoring belong to the caller. */
export function mountEditor(
  host: HTMLElement,
  options: EditorOptions
): () => void {
  let state = structuredClone(options.initial);
  let tool: Tool = "browse";
  let inkColor = "#c93848";
  let disposed = false;
  const measurement = document.createElement("canvas").getContext("2d");
  let draft: Mark | null = null;
  let activePointer: number | null = null;
  let textForm: HTMLFormElement | null = null;
  const history: AnnotationDocument[] = [];
  const cleanups: (() => void)[] = [];
  const surface = svgElement("svg") as SVGSVGElement;
  surface.classList.add("annotation-surface");
  surface.setAttribute("aria-label", "Documentation annotations");
  surface.setAttribute("role", "group");
  surface.setAttribute("tabindex", "0");
  surface.setAttribute(
    "aria-description",
    "Choose Add text, then press Enter to place a note. Escape returns to browsing."
  );
  const toolbar = document.createElement("div");
  toolbar.className = "annotation-toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Annotate documentation");
  toolbar.setAttribute("aria-orientation", "vertical");
  const status = document.createElement("span");
  status.className = "annotation-status";
  status.setAttribute("role", "status");
  const modeButtons = new Map<Tool, HTMLButtonElement>();

  function render() {
    const width = host.clientWidth;
    const height = host.clientHeight;
    surface.setAttribute("viewBox", `0 0 ${width} ${height}`);
    surface.setAttribute("width", String(width));
    surface.setAttribute("height", String(height));
    surface.replaceChildren();
    if (measurement) {
      measurement.font = `22px ${getComputedStyle(host).fontFamily}`;
    }
    const measure = (value: string) =>
      measurement?.measureText(value).width ?? value.length * 22;
    for (const mark of draft ? [...state.marks, draft] : state.marks) {
      const origin = options.resolveAnchor(mark.anchor);
      if (origin) {
        surface.append(renderMark(mark, origin, width, measure));
      }
    }
    undo.disabled = history.length === 0;
    clear.disabled = state.marks.length === 0;
  }

  function commit(next: AnnotationDocument) {
    if (next.marks.length > 300) {
      status.textContent =
        "This page has 300 annotations. Undo or clear before adding more.";
      return false;
    }
    history.push(state);
    if (history.length > 20) {
      history.shift();
    }
    state = next;
    options.onChange(structuredClone(state));
    render();
    return true;
  }

  function cancelDraft() {
    draft = null;
    if (activePointer !== null && surface.hasPointerCapture(activePointer)) {
      surface.releasePointerCapture(activePointer);
    }
    activePointer = null;
    textForm?.remove();
    textForm = null;
    render();
  }

  function selectTool(next: Tool) {
    cancelDraft();
    tool = next;
    host.dataset.annotationTool = next;
    for (const [name, button] of modeButtons) {
      button.setAttribute("aria-pressed", String(name === next));
    }
    const instructions = {
      browse: "Browse the docs",
      draw: "Draw on the page",
      text: "Click or press Enter to place text",
    };
    status.textContent = instructions[next];
    if (next === "text") {
      surface.focus({ preventScroll: true });
    }
  }

  for (const [name, label] of [
    ["browse", "Browse"],
    ["draw", "Draw"],
    ["text", "Add text"],
  ] as const) {
    const button = actionButton(label, () => selectTool(name));
    modeButtons.set(name, button);
    toolbar.append(button);
  }
  const undo = actionButton("Undo", () => {
    cancelDraft();
    const previous = history.pop();
    if (previous) {
      state = previous;
      options.onChange(structuredClone(state));
      status.textContent = "Last change undone";
      render();
    }
  });
  const clear = actionButton("Clear annotations", () => {
    cancelDraft();
    commit({ marks: [], version: 1 });
    status.textContent = "Annotations cleared. Undo to restore.";
  });
  const colorLabel = document.createElement("label");
  colorLabel.className = "annotation-color";
  colorLabel.dataset.tooltip = "Ink color";
  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.value = inkColor;
  colorInput.setAttribute("aria-label", "Ink color");
  colorInput.addEventListener("input", () => {
    inkColor = colorInput.value;
  });
  colorLabel.append(colorInput);
  toolbar.append(colorLabel, undo, clear, status);
  host.append(surface, toolbar);
  host.classList.add("annotation-host");

  function localPoint(event: PointerEvent): Point {
    const rect = host.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function createMark(point: Point, kind: Mark["kind"]): Mark {
    return {
      anchor: options.anchorAt(point.x, point.y),
      color: inkColor,
      id: crypto.randomUUID(),
      kind,
      points: [{ x: 0, y: 0 }],
      text: "",
    };
  }

  function openText(point: Point) {
    textForm?.remove();
    const mark = createMark(point, "text");
    const form = document.createElement("form");
    textForm = form;
    form.className = "annotation-text-form";
    form.style.left = `${Math.max(0, Math.min(point.x, host.clientWidth - 280))}px`;
    form.style.top = `${Math.max(0, point.y)}px`;
    const input = document.createElement("textarea");
    input.setAttribute("aria-label", "Annotation text");
    input.placeholder = "Write a note…";
    input.maxLength = 2000;
    input.rows = 3;
    const save = document.createElement("button");
    save.type = "submit";
    save.textContent = "Add note";
    const cancel = actionButton("Cancel", () => {
      form.remove();
      textForm = null;
      modeButtons.get("text")?.focus();
    });
    form.append(input, save, cancel);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) {
        input.focus();
        return;
      }
      if (!commit({ marks: [...state.marks, { ...mark, text }], version: 1 })) {
        return;
      }
      form.remove();
      textForm = null;
      status.textContent = "Note added";
      modeButtons.get("text")?.focus();
    });
    host.append(form);
    input.focus();
  }

  function pointerDown(event: PointerEvent) {
    if (event.button !== 0 || activePointer !== null) {
      return;
    }
    if (tool !== "browse" && state.marks.length >= 300) {
      status.textContent =
        "This page has 300 annotations. Undo or clear before adding more.";
      return;
    }
    if (tool === "text") {
      openText(localPoint(event));
    }
    if (tool === "draw") {
      event.preventDefault();
      activePointer = event.pointerId;
      draft = createMark(localPoint(event), "draw");
      surface.setPointerCapture(event.pointerId);
      render();
    }
  }

  function pointerMove(event: PointerEvent) {
    if (
      !(draft && event.pointerId === activePointer) ||
      draft.points.length >= 2000
    ) {
      return;
    }
    const origin = options.resolveAnchor(draft.anchor);
    if (!origin) {
      return;
    }
    const point = localPoint(event);
    const offset = { x: point.x - origin.x, y: point.y - origin.y };
    const previous = draft.points.at(-1);
    if (
      previous &&
      Math.hypot(offset.x - previous.x, offset.y - previous.y) < 1.5
    ) {
      return;
    }
    draft.points.push(offset);
    render();
  }

  function pointerUp(event: PointerEvent) {
    if (!(draft && event.pointerId === activePointer)) {
      return;
    }
    const mark = draft;
    draft = null;
    activePointer = null;
    if (surface.hasPointerCapture(event.pointerId)) {
      surface.releasePointerCapture(event.pointerId);
    }
    if (commit({ marks: [...state.marks, mark], version: 1 })) {
      status.textContent = "Drawing added";
    }
  }

  function keyDown(event: KeyboardEvent) {
    if (event.key === "Enter" && event.target === surface && tool === "text") {
      event.preventDefault();
      const rect = host.getBoundingClientRect();
      openText({
        x: host.clientWidth / 2,
        y: Math.max(0, Math.min(host.clientHeight - 100, 160 - rect.top)),
      });
    }
    if (
      event.key === "Escape" &&
      tool !== "browse" &&
      event.target instanceof Node &&
      host.contains(event.target)
    ) {
      event.preventDefault();
      selectTool("browse");
      modeButtons.get("browse")?.focus();
    }
  }
  surface.addEventListener("pointerdown", pointerDown);
  surface.addEventListener("pointermove", pointerMove);
  surface.addEventListener("pointerup", pointerUp);
  surface.addEventListener("pointercancel", cancelDraft);
  document.addEventListener("keydown", keyDown);
  const observer = new ResizeObserver(render);
  observer.observe(host);
  const article = host.parentElement?.querySelector("article");
  if (article) {
    observer.observe(article);
  }
  window.addEventListener("resize", render);
  cleanups.push(
    () => observer.disconnect(),
    () => window.removeEventListener("resize", render),
    () => document.removeEventListener("keydown", keyDown)
  );
  selectTool("browse");
  document.fonts.ready.then(() => {
    if (!disposed) {
      render();
    }
  });
  return () => {
    disposed = true;
    for (const cleanup of cleanups) {
      cleanup();
    }
    textForm?.remove();
    surface.remove();
    toolbar.remove();
    host.classList.remove("annotation-host");
    delete host.dataset.annotationTool;
  };
}
