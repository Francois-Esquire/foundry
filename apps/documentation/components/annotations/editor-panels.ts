import {
  type AnnotationDocument,
  LIMITS,
  type Mark,
  type TextTarget,
} from "../../lib/annotations/model.ts";
import { actionButton, placePanel } from "./editor-ui.ts";

interface PanelActions {
  clear: () => void;
  previous?: { available: () => boolean; restore: () => void };
  reattach: (mark: Mark) => void;
  remove: (id: string) => void;
  save: (mark: Mark) => boolean;
  selectTool: (tool: "highlight" | "underline" | "comment" | "arrow") => void;
}

export function createPanels(host: HTMLElement, actions: PanelActions) {
  let current: HTMLElement | null = null;
  function close() {
    current?.remove();
    current = null;
  }
  function panel(label: string, point?: { x: number; y: number }) {
    close();
    const element = document.createElement("section");
    element.className = "annotation-panel";
    element.setAttribute("role", "dialog");
    element.setAttribute("aria-label", label);
    const heading = document.createElement("h2");
    heading.textContent = label;
    const dismiss = actionButton("Close", close);
    dismiss.className = "annotation-panel-close";
    element.append(heading, dismiss);
    host.append(element);
    placePanel(element, point);
    current = element;
    return element;
  }
  function edit(mark: Mark, point?: { x: number; y: number }) {
    const element = panel(
      mark.kind === "comment" ? "Comment" : "Text note",
      point
    );
    const form = document.createElement("form");
    const input = document.createElement("textarea");
    input.setAttribute("aria-label", "Annotation text");
    input.rows = 4;
    input.maxLength = LIMITS.noteLength;
    input.placeholder = "Write a note…";
    input.value = mark.text;
    const save = document.createElement("button");
    save.type = "submit";
    save.textContent = mark.text ? "Save note" : "Add note";
    form.append(input, save);
    if (mark.target) {
      const quote = document.createElement("blockquote");
      quote.textContent = mark.target.segments
        .map((segment) => segment.quote)
        .join(" … ");
      element.append(quote);
    }
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) {
        input.focus();
        return;
      }
      if (actions.save({ ...mark, text })) {
        close();
      }
    });
    element.append(form);
    input.focus();
  }
  function appendRestore(element: HTMLElement) {
    if (!actions.previous?.available()) {
      return;
    }
    const { restore } = actions.previous;
    const note = document.createElement("p");
    note.textContent =
      "Your notes from before you edited a shared link are kept. Restoring them keeps the current notes as the previous copy.";
    element.append(
      note,
      actionButton("Restore previous notes", () => {
        close();
        restore();
      })
    );
  }
  function list(documentState: AnnotationDocument, unresolved: string[]) {
    const element = panel("Annotations");
    const description = document.createElement("p");
    description.textContent = documentState.marks.length
      ? `${documentState.marks.length} annotations. Select text before choosing Reattach.`
      : "No annotations yet. Select text to highlight or comment.";
    element.append(description);
    const tools = document.createElement("div");
    tools.className = "annotation-panel-tools";
    for (const [tool, label] of [
      ["highlight", "Highlight"],
      ["underline", "Underline"],
      ["comment", "Comment"],
      ["arrow", "Arrow"],
    ] as const) {
      const button = actionButton(label, () => {
        close();
        actions.selectTool(tool);
      });
      button.addEventListener("pointerdown", (event) => event.preventDefault());
      tools.append(button);
    }
    element.append(tools);
    for (const mark of documentState.marks) {
      const row = document.createElement("div");
      row.className = "annotation-list-row";
      const title = document.createElement("p");
      const quote = mark.target?.segments
        .map((segment) => segment.quote)
        .join(" … ");
      title.textContent = `${unresolved.includes(mark.id) ? "Unresolved · " : ""}${mark.kind}: ${(mark.text || quote || "Freehand sketch").slice(0, 120)}`;
      row.append(title);
      if (mark.kind === "comment" || mark.kind === "text") {
        row.append(actionButton("Edit", () => edit(mark)));
      }
      if (mark.target || unresolved.includes(mark.id)) {
        const attach = actionButton("Reattach", () => actions.reattach(mark));
        attach.addEventListener("pointerdown", (event) =>
          event.preventDefault()
        );
        row.append(attach);
      }
      row.append(
        actionButton("Delete", () => {
          actions.remove(mark.id);
          close();
        })
      );
      element.append(row);
    }
    if (documentState.marks.length) {
      element.append(
        actionButton("Clear annotations", () => {
          actions.clear();
          close();
        })
      );
    }
    appendRestore(element);
    element.querySelector<HTMLButtonElement>("button")?.focus();
  }
  function suggest(target: TextTarget, accept: () => void, reject: () => void) {
    const element = panel("Attach underline?");
    const quote = document.createElement("blockquote");
    quote.textContent = target.segments
      .map((segment) => segment.quote)
      .join(" … ");
    element.append(
      quote,
      actionButton("Attach underline", () => {
        accept();
        close();
      }),
      actionButton("Keep sketch", () => {
        reject();
        close();
      })
    );
    element.querySelector<HTMLButtonElement>("button")?.focus();
  }
  return {
    close,
    contains: (target: Node) => current?.contains(target) ?? false,
    edit,
    list,
    suggest,
  };
}
