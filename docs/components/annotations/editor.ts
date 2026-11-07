import {
  type Anchor,
  type AnnotationDocument,
  LIMITS,
  type Mark,
  type Point,
  type ShareResult,
  TEXT_MARK_KINDS,
  type TextAnchors,
  type TextTarget,
} from "../../lib/annotations/model.ts";
import {
  createGestureInput,
  listenAnnotationKeyboard,
} from "./editor-gestures.ts";
import { createPanels } from "./editor-panels.ts";
import { renderMarks } from "./editor-render.ts";
import { actionButton, createEditorChrome, labelButton } from "./editor-ui.ts";
import { interpretGesture } from "./gesture-attachment.ts";

type Tool =
  | "browse"
  | "draw"
  | "text"
  | "highlight"
  | "underline"
  | "arrow"
  | "comment";
type SelectTool = (typeof TEXT_MARK_KINDS)[number];
interface EditorOptions {
  anchorAt: (x: number, y: number) => Anchor;
  initial: AnnotationDocument;
  onChange: (document: AnnotationDocument) => void;
  onShare?: (document: AnnotationDocument) => Promise<ShareResult>;
  /** A copy of earlier notes the caller can swap back in; the editor never reads storage. */
  previous?: { available: () => boolean; restore: () => void };
  resolveAnchor: (anchor: Anchor) => Point | null;
  textAnchors: TextAnchors;
}
const TOOLS: [Tool, string][] = [
  ["browse", "Browse"],
  ["highlight", "Highlight"],
  ["underline", "Underline"],
  ["comment", "Comment"],
  ["arrow", "Arrow"],
  ["draw", "Draw"],
  ["text", "Add text"],
];
const SELECT_TOOLS = new Set<Tool>(TEXT_MARK_KINDS);
function isSelectTool(tool: Tool): tool is SelectTool {
  return SELECT_TOOLS.has(tool);
}

/** The editor accepts serializable state; callers own persistence and transport. */
export function mountEditor(
  host: HTMLElement,
  options: EditorOptions
): () => void {
  let state = structuredClone(options.initial);
  let tool: Tool = "browse";
  let visible = true;
  let disposed = false;
  let selection: TextTarget | null = null;
  let unresolved: string[] = [];
  let draft: Mark | null = null;
  let selectionTimer: ReturnType<typeof setTimeout> | undefined;
  let selectionFinished = false;
  const history: AnnotationDocument[] = [];
  const cleanups: (() => void)[] = [];
  const { surface, toolbar, status, feedback, contextual } =
    createEditorChrome();
  const buttons = new Map<Tool, HTMLButtonElement>();
  const measurement = document.createElement("canvas").getContext("2d");
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined;

  function announce(message: string, show = false) {
    status.textContent = message;
    if (show) {
      clearTimeout(feedbackTimer);
      feedback.textContent = message;
      feedback.hidden = false;
      feedbackTimer = setTimeout(() => {
        feedback.hidden = true;
      }, 7000);
    }
  }
  function commit(marks: Mark[]) {
    if (marks.length > LIMITS.marks) {
      announce(
        `This page has ${LIMITS.marks} annotations. Delete one before adding more.`,
        true
      );
      return false;
    }
    history.push(state);
    if (history.length > 20) {
      history.shift();
    }
    state = { marks, version: 1 };
    options.onChange(structuredClone(state));
    render();
    return true;
  }
  const panels = createPanels(host, {
    clear: () => {
      commit([]);
      announce("Annotations cleared. Undo restores them.", true);
    },
    previous: options.previous,
    reattach: (mark) => {
      const target = options.textAnchors.captureSelection() ?? selection;
      if (!target) {
        announce("Select the replacement text in the article first.", true);
        return;
      }
      commit(
        state.marks.map((current) =>
          current.id === mark.id ? { ...current, target } : current
        )
      );
      panels.close();
      announce("Annotation reattached", true);
    },
    remove: (id) => {
      commit(state.marks.filter((mark) => mark.id !== id));
      announce("Annotation deleted");
    },
    save: (mark) => {
      const exists = state.marks.some((current) => current.id === mark.id);
      const saved = commit(
        exists
          ? state.marks.map((current) =>
              current.id === mark.id ? mark : current
            )
          : [...state.marks, mark]
      );
      if (saved) {
        announce("Note saved");
      }
      return saved;
    },
    selectTool: (next) => {
      if (
        next !== "arrow" &&
        (options.textAnchors.captureSelection() ?? selection)
      ) {
        applySelection(next);
      } else {
        setTool(next);
      }
    },
  });
  function render() {
    if (disposed) {
      return;
    }
    const width = host.clientWidth;
    surface.setAttribute("viewBox", `0 0 ${width} ${host.clientHeight}`);
    surface.setAttribute("width", String(width));
    surface.setAttribute("height", String(host.clientHeight));
    if (measurement) {
      measurement.font = `22px ${getComputedStyle(host).fontFamily}`;
    }
    unresolved = renderMarks(
      surface,
      draft ? [...state.marks, draft] : state.marks,
      {
        commentWidth: Math.max(
          30,
          Math.min(
            width,
            toolbar.getBoundingClientRect().left -
              host.getBoundingClientRect().left -
              8
          )
        ),
        measure: (value) =>
          measurement?.measureText(value).width ?? value.length * 14,
        openNote: (mark) => panels.edit(mark),
        resolveAnchor: options.resolveAnchor,
        textAnchors: options.textAnchors,
        width,
      }
    );
    undo.disabled = !history.length;
    menu.dataset.unresolved = String(unresolved.length);
    menu.setAttribute(
      "aria-label",
      unresolved.length
        ? `Annotation menu, ${unresolved.length} unresolved`
        : "Annotation menu"
    );
  }
  function cancelDraft() {
    gestures.cancel();
  }
  function setTool(next: Tool) {
    cancelDraft();
    tool = next;
    host.dataset.annotationTool = next;
    for (const [name, button] of buttons) {
      button.setAttribute(
        "aria-pressed",
        String(name === next || (name === "draw" && next === "arrow"))
      );
    }
    if (next === "text") {
      surface.focus({ preventScroll: true });
    }
    if (isSelectTool(next)) {
      announce("Select text in the article to apply this tool.", true);
    } else {
      const instructions: Partial<Record<Tool, string>> = {
        arrow: "Drag an arrow toward a word or title.",
        browse: "Browse the docs",
        draw: "Draw a sketch. Underlines can attach to nearby text.",
        text: "Click or press Enter to place text.",
      };
      announce(instructions[next] ?? "Select text in the article.");
    }
  }
  function makeMark(
    kind: Mark["kind"],
    point: Point,
    target?: TextTarget
  ): Mark {
    return {
      anchor: options.anchorAt(point.x, point.y),
      color: color.value,
      id: crypto.randomUUID(),
      kind,
      points: [{ x: 0, y: 0 }],
      text: "",
      ...(target ? { target } : {}),
    };
  }
  function applySelection(kind: SelectTool) {
    const target = options.textAnchors.captureSelection() ?? selection;
    if (!target) {
      announce("Select text in the article first.", true);
      return;
    }
    const rect = options.textAnchors.resolveTarget(target)?.[0];
    if (!rect) {
      announce("That selection is no longer available. Select it again.", true);
      return;
    }
    const mark = makeMark(kind, rect, target);
    contextual.hidden = true;
    selection = null;
    window.getSelection()?.removeAllRanges();
    if (kind === "comment") {
      panels.edit(mark);
    } else {
      commit([...state.marks, mark]);
      announce(`${kind === "highlight" ? "Highlight" : "Underline"} added`);
    }
    setTool("browse");
  }
  for (const [name, label] of TOOLS) {
    const button = actionButton(label, () => {
      const target = options.textAnchors.captureSelection() ?? selection;
      if (isSelectTool(name) && target) {
        applySelection(name);
      } else {
        setTool(name);
      }
    });
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    buttons.set(name, button);
    if (["browse", "draw", "text"].includes(name)) {
      toolbar.append(button);
    }
  }
  const colorLabel = document.createElement("label");
  colorLabel.className = "annotation-color";
  colorLabel.dataset.tooltip = "Ink color";
  const color = document.createElement("input");
  color.type = "color";
  color.value = "#c93848";
  color.setAttribute("aria-label", "Ink color");
  colorLabel.append(color);
  const undo = actionButton("Undo", () => {
    cancelDraft();
    panels.close();
    const previous = history.pop();
    if (previous) {
      state = previous;
      options.onChange(structuredClone(state));
      render();
      announce("Last change undone");
    }
  });
  const menu = actionButton("Annotation menu", () =>
    panels.list(state, unresolved)
  );
  menu.addEventListener("pointerdown", (event) => event.preventDefault());
  const share = actionButton("Share annotations", async () => {
    if (!options.onShare) {
      return;
    }
    share.disabled = true;
    try {
      const result = await options.onShare(structuredClone(state));
      if (!disposed) {
        announce(result.message, true);
      }
    } catch {
      if (!disposed) {
        announce(
          "Could not create a share link. Your annotations remain saved here.",
          true
        );
      }
    } finally {
      if (!disposed) {
        share.disabled = false;
      }
    }
  });
  share.disabled = !options.onShare;
  const eye = actionButton("Hide annotations", () => {
    visible = !visible;
    if (!visible) {
      setTool("browse");
      panels.close();
      contextual.hidden = true;
      feedback.hidden = true;
    }
    host.dataset.annotationsHidden = String(!visible);
    surface.setAttribute("aria-hidden", String(!visible));
    surface.setAttribute("tabindex", visible ? "0" : "-1");
    eye.setAttribute("aria-pressed", String(!visible));
    labelButton(eye, visible ? "Hide annotations" : "Show annotations");
    announce(
      visible
        ? "Annotations shown"
        : "Annotations hidden. Shared state is unchanged."
    );
  });
  eye.classList.add("annotation-visibility");
  eye.setAttribute("aria-pressed", "false");
  toolbar.prepend(eye);
  toolbar.append(colorLabel, undo, share, menu, status);
  for (const kind of TEXT_MARK_KINDS) {
    contextual.append(
      actionButton(
        { comment: "Comment", highlight: "Highlight", underline: "Underline" }[
          kind
        ],
        () => applySelection(kind)
      )
    );
  }
  contextual.addEventListener("pointerdown", (event) => event.preventDefault());
  host.append(surface, toolbar, contextual, feedback);
  host.classList.add("annotation-host");
  host.dataset.annotationsHidden = "false";

  function updateSelection(finished: boolean) {
    if (!visible || disposed) {
      return;
    }
    const target = options.textAnchors.captureSelection();
    if (!target) {
      contextual.hidden = true;
      if (!host.contains(document.activeElement)) {
        selection = null;
      }
      return;
    }
    selection = target;
    if (isSelectTool(tool) && finished) {
      applySelection(tool);
      return;
    }
    if (tool !== "browse") {
      return;
    }
    const rect = options.textAnchors.resolveTarget(target)?.[0];
    if (!rect) {
      return;
    }
    const hostRect = host.getBoundingClientRect();
    contextual.style.left = `${Math.max(8, Math.min(hostRect.left + rect.x, window.innerWidth - 154))}px`;
    contextual.style.top = `${Math.max(68, Math.min(hostRect.top + rect.y - 50, window.innerHeight - 58))}px`;
    contextual.hidden = false;
  }
  function selectionChanged(event: Event) {
    selectionFinished ||= event.type === "pointerup" || event.type === "keyup";
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      const finished = selectionFinished;
      selectionFinished = false;
      updateSelection(finished);
    }, 150);
  }
  function completeGesture(raw: Mark, first: Point, tip: Point) {
    const { mark, suggestion: target } = interpretGesture(
      raw,
      first,
      tip,
      options.textAnchors,
      selection
    );
    if (!commit([...state.marks, mark])) {
      return;
    }
    if (mark.kind === "arrow") {
      announce(
        mark.target ? "Arrow attached to text" : "Arrow added to block",
        true
      );
      return;
    }
    if (target) {
      panels.suggest(
        target,
        () => {
          commit(
            state.marks.map((current) =>
              current.id === mark.id
                ? { ...current, kind: "underline", points: [], target }
                : current
            )
          );
          announce("Underline attached to text", true);
        },
        () => announce("Sketch kept")
      );
    } else {
      announce("Drawing added");
    }
  }
  cleanups.push(
    listenAnnotationKeyboard(host, surface, {
      addText: (point) => panels.edit(makeMark("text", point)),
      escape: (event) => {
        panels.close();
        contextual.hidden = true;
        if (tool !== "browse") {
          event.preventDefault();
          setTool("browse");
          buttons.get("browse")?.focus();
        }
      },
      textActive: () => tool === "text",
    })
  );
  const gestures = createGestureInput(host, surface, {
    anchorAt: options.anchorAt,
    complete: completeGesture,
    enabled: () => visible,
    makeMark,
    preview: (mark) => {
      draft = mark;
      render();
    },
    textAt: (point, client) => panels.edit(makeMark("text", point), client),
    tool: () => tool,
  });
  cleanups.push(() => gestures.dispose());
  document.addEventListener("selectionchange", selectionChanged);
  document.addEventListener("pointerup", selectionChanged);
  document.addEventListener("keyup", selectionChanged);
  const observer = new ResizeObserver(render);
  observer.observe(host);
  const themeObserver = new MutationObserver(render);
  themeObserver.observe(document.documentElement, {
    attributeFilter: ["class", "data-theme"],
    attributes: true,
  });
  window.addEventListener("resize", render);
  window.addEventListener(
    "scroll",
    () => {
      contextual.hidden = true;
    },
    { passive: true, signal: createScrollSignal() }
  );
  function createScrollSignal() {
    const controller = new AbortController();
    cleanups.push(() => controller.abort());
    return controller.signal;
  }
  cleanups.push(
    () => observer.disconnect(),
    () => themeObserver.disconnect(),
    () => window.removeEventListener("resize", render),
    () => document.removeEventListener("selectionchange", selectionChanged),
    () => document.removeEventListener("pointerup", selectionChanged),
    () => document.removeEventListener("keyup", selectionChanged)
  );
  setTool("browse");
  async function renderAfterFonts() {
    await document.fonts?.ready;
    if (!disposed) {
      render();
    }
  }
  renderAfterFonts();
  return () => {
    disposed = true;
    clearTimeout(selectionTimer);
    clearTimeout(feedbackTimer);
    for (const cleanup of cleanups) {
      cleanup();
    }
    panels.close();
    surface.remove();
    toolbar.remove();
    contextual.remove();
    feedback.remove();
    host.classList.remove("annotation-host");
    delete host.dataset.annotationTool;
    delete host.dataset.annotationsHidden;
  };
}
