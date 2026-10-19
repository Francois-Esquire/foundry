import { chartFrame } from "../../layout/chart-frame";
import {
  type GridReference,
  gridReferenceLimits,
  gridReferenceStyle,
} from "../../layout/margin-notes";
import { flatMarkHeight } from "../../layout/terrain-height";
import { fontFamily, type TextMetrics } from "./measure";
import { type Frame, keyedElements, squash } from "./text-element";

const svgNamespace = "http://www.w3.org/2000/svg";
let nextMask = 0;

interface ReferenceText {
  cutout: SVGTextElement;
  outline: SVGTextElement;
}

/** The lining follows chart limits; a luminance mask cuts coordinate glyphs out of the cast fill. */
export function createFrameBorder(parent: HTMLElement, metrics: TextMetrics) {
  const svg = document.createElementNS(svgNamespace, "svg");
  svg.setAttribute("class", "spyglass-chart-frame");
  svg.setAttribute("aria-hidden", "true");
  const defs = document.createElementNS(svgNamespace, "defs");
  const mask = document.createElementNS(svgNamespace, "mask");
  const maskId = `spyglass-coordinate-cutout-${nextMask}`;
  nextMask += 1;
  mask.setAttribute("id", maskId);
  mask.setAttribute("maskUnits", "userSpaceOnUse");
  mask.setAttribute("mask-type", "luminance");
  const paper = document.createElementNS(svgNamespace, "rect");
  paper.setAttribute("width", "100%");
  paper.setAttribute("height", "100%");
  paper.setAttribute("fill", "white");
  mask.append(paper);
  defs.append(mask);
  const clipId = `${maskId}-cast`;
  const clip = document.createElementNS(svgNamespace, "clipPath");
  clip.setAttribute("id", clipId);
  const clipOutline = document.createElementNS(svgNamespace, "path");
  clip.append(clipOutline);
  defs.append(clip);
  svg.append(defs);
  const path = (className: string, into: SVGElement = svg) => {
    const element = document.createElementNS(svgNamespace, "path");
    element.setAttribute("class", className);
    into.append(element);
    return element;
  };
  const cast = document.createElementNS(svgNamespace, "g");
  cast.setAttribute("mask", `url(#${maskId})`);
  svg.append(cast);
  const corner = path("spyglass-corner-diamond");
  const panels = path("spyglass-frame-panels", cast);
  const inset = path("spyglass-cast-inset", cast);
  inset.setAttribute("clip-path", `url(#${clipId})`);
  const border = path("spyglass-frame-rule");
  svg.insertBefore(border, cast);
  const edge = path("spyglass-cast-edge", cast);
  const ornament = path("spyglass-frame-ornament");
  parent.prepend(svg);
  const outlines = document.createElementNS(svgNamespace, "g");
  svg.append(outlines);
  const textNode = (
    reference: GridReference,
    className: string,
    into: SVGElement,
    fill: string
  ) => {
    const text = document.createElementNS(svgNamespace, "text");
    text.setAttribute("class", className);
    text.setAttribute("fill", fill);
    text.setAttribute("text-anchor", "middle");
    text.style.fontFamily = fontFamily(gridReferenceStyle.font);
    text.style.fontSize = `${gridReferenceStyle.size}px`;
    text.style.letterSpacing = `${gridReferenceStyle.font.letterSpacing}em`;
    text.textContent = reference.text;
    into.append(text);
    return text;
  };
  const cutouts = keyedElements<string, GridReference, ReferenceText>({
    create(reference) {
      return {
        cutout: textNode(reference, "spyglass-reference", mask, "black"),
        outline: textNode(
          reference,
          "spyglass-reference-outline",
          outlines,
          "none"
        ),
      };
    },
    key: (reference) => `${reference.edge}:${reference.text}`,
    retire(text) {
      text.cutout.remove();
      text.outline.remove();
    },
  });
  let previous = "";
  return (frame: Frame, references: readonly GridReference[]) => {
    const width = frame.view.width * frame.pixels;
    const height = frame.view.height * frame.pixels * squash;
    const geometry = chartFrame(
      width,
      height,
      gridReferenceLimits(frame.state.drawingData).map((reference) => {
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
    if (key !== previous) {
      previous = key;
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      mask.setAttribute("x", "0");
      mask.setAttribute("y", "0");
      mask.setAttribute("width", `${width}`);
      mask.setAttribute("height", `${height}`);
      panels.setAttribute("d", geometry.panels);
      corner.setAttribute("d", geometry.corner);
      clipOutline.setAttribute("d", geometry.panels);
      inset.setAttribute("d", geometry.panels);
      edge.setAttribute("d", geometry.panels);
      border.setAttribute("d", geometry.border);
      ornament.setAttribute("d", geometry.ornament);
    }
    const baseline =
      (metrics.baseline(gridReferenceStyle.font) - 0.5) *
      gridReferenceStyle.size;
    cutouts.reconcile(references, (text, reference) => {
      const at = frame.screen(reference.x, reference.y, flatMarkHeight);
      const x = `${Math.round(at.x * frame.pixelRatio) / frame.pixelRatio}`;
      const y = `${Math.round((at.y + baseline) * frame.pixelRatio) / frame.pixelRatio}`;
      for (const element of [text.cutout, text.outline]) {
        element.setAttribute("x", x);
        element.setAttribute("y", y);
      }
    });
  };
}
