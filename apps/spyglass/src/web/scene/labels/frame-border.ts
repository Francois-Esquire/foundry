import { chartFrame } from "../../layout/chart-frame";
import {
  type GridReference,
  gridReferenceStyle,
} from "../../layout/margin-notes";
import { flatMarkHeight } from "../../layout/terrain-height";
import type { TextMetrics } from "./measure";
import { type Frame, squash } from "./text-element";

const svgNamespace = "http://www.w3.org/2000/svg";

/** The border follows the same projected references as the lettering. No DOM measurements per frame. */
export function createFrameBorder(parent: HTMLElement, metrics: TextMetrics) {
  const svg = document.createElementNS(svgNamespace, "svg");
  svg.setAttribute("class", "spyglass-chart-frame");
  svg.setAttribute("aria-hidden", "true");
  const path = (className: string) => {
    const element = document.createElementNS(svgNamespace, "path");
    element.setAttribute("class", className);
    svg.append(element);
    return element;
  };
  const border = path("spyglass-frame-rule");
  const ornament = path("spyglass-frame-ornament");
  parent.prepend(svg);
  let previous = "";
  return (frame: Frame, references: readonly GridReference[]) => {
    const width = frame.view.width * frame.pixels;
    const height = frame.view.height * frame.pixels * squash;
    const geometry = chartFrame(
      width,
      height,
      references.map((reference) => {
        const at = frame.screen(reference.x, reference.y, flatMarkHeight);
        return {
          edge: reference.edge,
          halfWidth:
            reference.edge === "top"
              ? (metrics.measure(reference.text, gridReferenceStyle.font) *
                  gridReferenceStyle.size) /
                2
              : gridReferenceStyle.size / 2,
          position: reference.edge === "top" ? at.x : at.y,
        };
      })
    );
    const key = `${width}|${height}|${geometry.border}|${geometry.ornament}`;
    if (key === previous) {
      return;
    }
    previous = key;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    border.setAttribute("d", geometry.border);
    ornament.setAttribute("d", geometry.ornament);
  };
}
