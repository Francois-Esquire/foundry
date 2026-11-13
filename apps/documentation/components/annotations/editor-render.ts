import { fitStroke } from "../../lib/annotations/geometry.ts";
import type {
  Anchor,
  Mark,
  Point,
  TextAnchors,
  TextRect,
} from "../../lib/annotations/model.ts";
import { svgElement } from "./editor-ui.ts";

interface RenderOptions {
  commentWidth?: number;
  measure: (value: string) => number;
  openNote: (mark: Mark) => void;
  resolveAnchor: (anchor: Anchor) => Point | null;
  textAnchors: TextAnchors;
  width: number;
}

function wrap(value: string, width: number, measure: RenderOptions["measure"]) {
  const lines: string[] = [];
  for (const paragraph of value.split("\n")) {
    let line = "";
    for (const character of paragraph) {
      if (line && measure(line + character) > width) {
        const space = line.lastIndexOf(" ");
        lines.push(space > 0 ? line.slice(0, space) : line);
        line = (space > 0 ? line.slice(space + 1) : "") + character;
      } else {
        line += character;
      }
    }
    lines.push(line);
  }
  return lines;
}

function path(d: string) {
  const element = svgElement("path");
  element.setAttribute("d", d);
  element.setAttribute("fill", "none");
  element.setAttribute("stroke", "currentColor");
  element.setAttribute("stroke-width", "2.5");
  element.setAttribute("stroke-linecap", "round");
  element.setAttribute("stroke-linejoin", "round");
  return element;
}

function renderText(
  group: SVGElement,
  mark: Mark,
  origin: Point,
  options: RenderOptions
) {
  const text = svgElement("text");
  const width = Math.max(1, Math.min(280, options.width - 16));
  const x = Math.max(8, Math.min(origin.x, options.width - width - 8));
  text.setAttribute("x", String(x));
  text.setAttribute("y", String(origin.y));
  text.setAttribute("fill", "currentColor");
  text.classList.add("annotation-text");
  for (const [index, line] of wrap(
    mark.text,
    width,
    options.measure
  ).entries()) {
    const span = svgElement("tspan");
    span.setAttribute("x", String(x));
    span.setAttribute("dy", index ? "1.3em" : "0");
    span.textContent = line || " ";
    text.append(span);
  }
  group.append(text);
}

function renderRange(group: SVGElement, mark: Mark, rects: TextRect[]) {
  for (const rect of rects) {
    if (mark.kind === "highlight") {
      const highlight = svgElement("rect");
      highlight.classList.add("annotation-highlight");
      highlight.setAttribute("x", String(rect.x - 1));
      highlight.setAttribute("y", String(rect.y + 1));
      highlight.setAttribute("width", String(rect.width + 2));
      highlight.setAttribute("height", String(Math.max(2, rect.height - 1)));
      highlight.setAttribute("rx", "2");
      highlight.setAttribute("fill", mark.color);
      group.append(highlight);
    } else {
      group.append(
        path(
          `M${rect.x},${rect.y + rect.height + 1} Q${rect.x + rect.width / 2},${rect.y + rect.height + 2.5} ${rect.x + rect.width},${rect.y + rect.height + 1}`
        )
      );
    }
  }
}

function renderArrow(
  group: SVGElement,
  mark: Mark,
  origin: Point,
  width: number
) {
  const tail = mark.points[0] ?? { x: -70, y: -35 };
  const tip = { x: Math.max(8, Math.min(origin.x, width - 8)), y: origin.y };
  const start = {
    x: Math.max(8, Math.min(tip.x + tail.x, width - 8)),
    y: tip.y + tail.y,
  };
  const angle = Math.atan2(tip.y - start.y, tip.x - start.x);
  const wing = (offset: number) =>
    `${tip.x - 10 * Math.cos(angle + offset)},${tip.y - 10 * Math.sin(angle + offset)}`;
  group.append(
    path(
      `M${start.x},${start.y} L${tip.x},${tip.y} M${wing(0.5)} L${tip.x},${tip.y} L${wing(-0.5)}`
    )
  );
}

function renderComment(
  group: SVGElement,
  mark: Mark,
  rect: TextRect,
  options: RenderOptions
) {
  const marker = svgElement("g");
  const x = Math.max(
    7,
    Math.min(
      rect.x + rect.width + 4,
      (options.commentWidth ?? options.width) - 37
    )
  );
  marker.classList.add("annotation-comment-marker");
  marker.setAttribute("transform", `translate(${x} ${rect.y - 4})`);
  marker.setAttribute("role", "button");
  marker.setAttribute("tabindex", "0");
  marker.setAttribute("aria-label", `Open comment: ${mark.text.slice(0, 80)}`);
  const circle = svgElement("rect");
  circle.setAttribute("width", "30");
  circle.setAttribute("height", "30");
  circle.setAttribute("rx", "8");
  circle.setAttribute("fill", "var(--blume-background)");
  circle.setAttribute("stroke", "currentColor");
  const icon = path("M8 9h14v10h-8l-6 5Z");
  const hit = svgElement("rect");
  hit.setAttribute("x", "-7");
  hit.setAttribute("y", "-7");
  hit.setAttribute("width", "44");
  hit.setAttribute("height", "44");
  hit.setAttribute("fill", "transparent");
  marker.append(hit, circle, icon);
  marker.addEventListener("click", () => options.openNote(mark));
  marker.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      options.openNote(mark);
    }
  });
  group.append(marker);
}

function renderContent(
  group: SVGElement,
  mark: Mark,
  origin: Point,
  rects: TextRect[] | null,
  options: RenderOptions
) {
  if (mark.kind === "highlight" || mark.kind === "underline") {
    renderRange(group, mark, rects ?? []);
  } else if (mark.kind === "comment" && rects?.[0]) {
    renderComment(group, mark, rects[0], options);
  } else if (mark.kind === "text") {
    renderText(group, mark, origin, options);
  } else if (mark.kind === "arrow") {
    renderArrow(
      group,
      mark,
      { x: origin.x, y: origin.y + (rects?.[0]?.height ?? 0) / 2 },
      options.width
    );
  } else {
    const points = fitStroke(mark.points, origin, options.width);
    group.append(
      path(
        `M${points.map((point) => `${point.x},${point.y}`).join(" L")} l0.01,0.01`
      )
    );
  }
}

export function renderMarks(
  surface: SVGElement,
  marks: Mark[],
  options: RenderOptions
): string[] {
  const unresolved: string[] = [];
  surface.replaceChildren();
  for (const mark of [...marks].sort(
    (a, b) => Number(b.kind === "highlight") - Number(a.kind === "highlight")
  )) {
    const rects = mark.target
      ? options.textAnchors.resolveTarget(mark.target)
      : null;
    const origin = mark.target
      ? rects?.[0]
      : options.resolveAnchor(mark.anchor);
    if (!origin || (mark.target && !rects?.length)) {
      unresolved.push(mark.id);
      continue;
    }
    const group = svgElement("g");
    group.classList.add("annotation-ink");
    group.style.setProperty("--annotation-ink", mark.color);
    group.dataset.markId = mark.id;
    renderContent(group, mark, origin, rects, options);
    surface.append(group);
  }
  return unresolved;
}
