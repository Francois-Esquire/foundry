import type { SpyglassFile, Territory } from "../data/types";
import { inkAlpha, inks } from "../ladder/ink-ladder";
import { inkStyle } from "../ladder/ink-table";
import { detailLevel } from "../view/detail-level";
import { compositionMarks } from "./composition-marks";
import type { Mark, MarkAlpha, Stroke } from "./marks";
import { glyphOn, inkedStroke, runPoints } from "./marks";
import type { ResponsibilityOverlay } from "./responsibility-focus";
import { routeMarks } from "./scenario-route-marks";

/** What the overlay's marks are built from: the selected island and its overlay, at the zoom the screen-sized lines are laid for. */
export interface ResponsibilityMarkInputs {
  overlay: ResponsibilityOverlay;
  /** The zoom the marks are built for: the arcs, arrowheads and diamonds are laid in world units at it. */
  pixels: number;
  territory: Territory;
}

/** The screen-sized marks round a file, in CSS pixels. */
const fileRings = {
  hint: 5,
  member: 3.5,
  notch: { from: 2, to: 6 },
  related: 2.5,
  unresolved: 6,
} as const;
/** The hint's arc, in canvas radians: open toward the north-east. */
const hintArc = { from: 0.3, to: Math.PI * 1.6 } as const;

/** The files' detail with or without a composition: shared, so the renderer batches by them. */
const filesDetail: MarkAlpha = (pixels) => detailLevel(pixels, false).files;
const filesDetailUnderComposition: MarkAlpha = (pixels) =>
  detailLevel(pixels, true).files;

/** Whether the overlay has anything laid in world units at the zoom, so its layer is built again as the zoom changes. */
export function responsibilityFollowsZoom(
  overlay: ResponsibilityOverlay
): boolean {
  return (
    (overlay.composition?.marks.length ?? 0) > 0 ||
    (overlay.hints?.length ?? 0) > 0 ||
    overlay.unresolved.length > 0 ||
    overlay.routes !== undefined
  );
}

/** An arc about a point as a polyline, in canvas radians (clockwise on the chart, whose y runs south). */
function arcPoints(
  x: number,
  y: number,
  radius: number,
  from: number,
  to: number,
  segments = 16
): number[] {
  const points: number[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const angle = from + ((to - from) * i) / segments;
    points.push(x + radius * Math.cos(angle), y + radius * Math.sin(angle));
  }
  return points;
}

/** A dotted arc round each file the overlay suggests looking at, laid in world units at the zoom. */
function hintMarks(
  inputs: ResponsibilityMarkInputs,
  files: Map<string, SpyglassFile>
): Stroke[] {
  const { overlay, pixels, territory } = inputs;
  const hint = inkStyle("inspection-hint");
  const marks: Stroke[] = [];
  for (const id of overlay.hints ?? []) {
    const file = files.get(id);
    if (!file) {
      continue;
    }
    const arc = arcPoints(
      file.x,
      file.y,
      fileRings.hint / pixels,
      hintArc.from,
      hintArc.to
    );
    marks.push(
      inkedStroke(hint, runPoints(arc, territory.x, territory.y), {
        cap: "butt",
        on: territory,
      })
    );
  }
  return marks;
}

/** A dashed link between two evidence files. */
function linkMarks(
  inputs: ResponsibilityMarkInputs,
  files: Map<string, SpyglassFile>
): Stroke[] {
  const { overlay, territory } = inputs;
  const link = inkStyle("inspection-link");
  const marks: Stroke[] = [];
  for (const { source, target } of overlay.links) {
    const a = files.get(source);
    const b = files.get(target);
    if (!(a && b)) {
      continue;
    }
    marks.push(
      inkedStroke(
        link,
        runPoints([a.x, a.y, b.x, b.y], territory.x, territory.y),
        { alpha: inkAlpha.inspectionLink, cap: "butt", on: territory }
      )
    );
  }
  return marks;
}

/**
 * The overlay's entries, at the files' detail: a ring round each related
 * file and a larger one round each member, a notch toward the north-east on
 * a file whose folder disagrees with its responsibility, and a dashed
 * diamond round an unresolved file, laid in world units at the zoom.
 */
function entryMarks(
  inputs: ResponsibilityMarkInputs,
  files: Map<string, SpyglassFile>
): Mark[] {
  const { overlay, pixels, territory } = inputs;
  const alpha =
    (overlay.composition?.marks.length ?? 0) > 0
      ? filesDetailUnderComposition
      : filesDetail;
  const marks: Mark[] = [];
  for (const [ids, style, radius] of [
    [overlay.related, inkStyle("inspection-related"), fileRings.related],
    [overlay.members, inkStyle("inspection-focus"), fileRings.member],
  ] as const) {
    for (const id of ids) {
      const file = files.get(id);
      if (file) {
        marks.push(
          glyphOn(territory, file, {
            alpha,
            colour: style.hue,
            shape: "hoop",
            size: 2 * radius,
            weight: style.weight,
          })
        );
      }
    }
  }
  const notch = inkStyle("inspection-notch");
  for (const id of overlay.pathDisagreement) {
    const file = files.get(id);
    if (file) {
      marks.push(
        glyphOn(territory, file, {
          alpha,
          colour: inks.inspectionWarning,
          shape: "notch",
          size: fileRings.notch.to + fileRings.notch.from,
          weight: notch.weight,
        })
      );
    }
  }
  const unresolved = inkStyle("inspection-unresolved");
  const r = fileRings.unresolved / pixels;
  for (const id of overlay.unresolved) {
    const file = files.get(id);
    if (file) {
      const diamond = [
        file.x,
        file.y - r,
        file.x + r,
        file.y,
        file.x,
        file.y + r,
        file.x - r,
        file.y,
        file.x,
        file.y - r,
      ];
      marks.push(
        inkedStroke(unresolved, runPoints(diamond, territory.x, territory.y), {
          alpha,
          cap: "butt",
          colour: inks.inspectionWarning,
          on: territory,
        })
      );
    }
  }
  return marks;
}

/**
 * The architectural overlay of the selected island's responsibility, every
 * mark draped on its relief: the composition drawing
 * (`composition-marks.ts`), the scenario's routes
 * (`scenario-route-marks.ts`), the hints, the links between evidence files,
 * and the entries. The overlay's animations (a route's and a trace's
 * progress) arrive as a new overlay and rebuild the layer; the arcs,
 * arrowheads and diamonds are laid in world units at the zoom, so the layer
 * is built again as the zoom changes while the overlay has any
 * (`responsibilityFollowsZoom`).
 */
export function responsibilityMarks(inputs: ResponsibilityMarkInputs): Mark[] {
  const { overlay, pixels, territory } = inputs;
  const files = new Map(territory.files.map((file) => [file.id, file]));
  const composition = compositionMarks(overlay, pixels, territory);
  return [
    ...composition,
    ...[
      ...routeMarks(overlay, pixels, territory, files),
      ...hintMarks(inputs, files),
      ...linkMarks(inputs, files),
      ...entryMarks(inputs, files),
    ].map((mark) => ({ ...mark, order: composition.length })),
  ];
}
