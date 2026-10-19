import type { CSSProperties } from "react";
import { channels, inks } from "../ladder/ink-ladder";
import type { LabelFont } from "../layout/labels";
import { flatMarkHeight } from "../layout/terrain-height";
import { isSceneLayerVisible } from "../settings/scene-composition";
import { viewSquash } from "../view/chart-view";
import { detailLevel } from "../view/detail-level";
import { chartFrame } from "./chart-frame-layout";
import {
  gridReferenceLimits,
  gridReferenceStyle,
  gridReferences,
  latitudeScale,
  latitudeScaleStyle,
  marginNote,
  marginNoteFits,
  seaCaption,
} from "./chart-margin-layout";
import { fontFamily, type TextMetrics } from "./map-labels/measure";
import { type Frame, squash } from "./map-labels/text-element";

export interface ChromeText {
  key: string;
  style: CSSProperties;
  text: string;
}

interface PlateStyle extends CSSProperties {
  "--spyglass-plate": string;
  "--spyglass-plate-height": string;
  "--spyglass-plate-pad": string;
}

export interface ChartChromeModel {
  coordinates: { key: string; text: string; x: number; y: number }[];
  frameVisible: boolean;
  geometry: ReturnType<typeof chartFrame>;
  height: number;
  notes: ChromeText[];
  plateStyle: PlateStyle;
  scale: {
    opacity: number;
    plated: boolean;
    x: number;
    top: number;
    bottom: number;
    ticks: { key: number; y: number; label: ChromeText }[];
  } | null;
  width: number;
}

function snap(value: number, ratio: number): number {
  return Math.round(value * ratio) / ratio;
}

function lettering(
  font: LabelFont,
  size: number,
  ink: string,
  halo = 0
): CSSProperties {
  return {
    color: ink,
    fontFamily: fontFamily(font),
    fontSize: size,
    fontStyle: font.italic ? "italic" : "normal",
    letterSpacing: `${font.letterSpacing}em`,
    WebkitTextStroke: halo ? `${halo}px ${inks.labelHalo}` : undefined,
  };
}

function position(x: number, y: number, ratio: number, scale: number): string {
  return `translate(${snap(x, ratio)}px, ${snap(y, ratio)}px) scaleY(${scale})`;
}

/** Keep the decorative caption legible without letting zoom enlarge it into the controls. */
function captionNotes(
  frame: Frame,
  metrics: TextMetrics,
  viewport: { width: number; height: number },
  textScale: number
): ChromeText[] {
  const candidates = seaCaption(frame.state.drawingData).map((note, index) => {
    const at = frame.screen(note.x, note.y, flatMarkHeight);
    const size =
      index === 0
        ? Math.min(18, Math.max(12, note.size * frame.pixels))
        : Math.min(9, Math.max(8, note.size * frame.pixels));
    const width = metrics.measure(note.text, note.font) * size;
    const left = at.x - width / 2;
    const top = at.y - textScale * metrics.baseline(note.font) * size;
    return {
      bounds: {
        bottom: top + size * textScale,
        left,
        right: left + width,
        top,
      },
      item: {
        key: `sea-caption-${index}`,
        style: {
          ...lettering(note.font, size, note.ink),
          transform: position(left, top, frame.pixelRatio, textScale),
        },
        text: note.text,
      },
    };
  });
  return candidates.every(({ bounds }) =>
    marginNoteFits(bounds, viewport, frame.exclusions)
  )
    ? candidates.map(({ item }) => item)
    : [];
}

/** Prepare immutable, screen-space props in the UI. React never reads the live camera or scene state. */
function chartChromeModel(
  frame: Frame,
  metrics: TextMetrics
): ChartChromeModel {
  const { state, view, pixels, pixelRatio } = frame;
  const data = state.drawingData;
  const textScale = view.tilt === undefined ? squash : 1;
  const visible = (id: Parameters<typeof isSceneLayerVisible>[1]) =>
    isSceneLayerVisible(state.settings.composition, id);
  const references = visible("coordinates") ? gridReferences(view, data) : [];
  const coordinateBaseline =
    (metrics.baseline(gridReferenceStyle.font) - 0.5) * gridReferenceStyle.size;
  const width = view.width * pixels;
  const height = view.height * pixels * viewSquash(view);
  const geometry = chartFrame(
    width,
    height,
    (visible("coordinates") ? gridReferenceLimits(data) : []).map(
      (reference) => {
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
      }
    )
  );
  const coordinates = references.map((reference) => {
    const at = frame.screen(reference.x, reference.y, flatMarkHeight);
    return {
      key: `${reference.edge}:${reference.text}`,
      text: reference.text,
      x: snap(at.x, pixelRatio),
      y: snap(at.y + coordinateBaseline, pixelRatio),
    };
  });
  const laidScale = latitudeScale(
    data,
    view,
    detailLevel(pixels).scale,
    state.legendHeight
  );
  let scale: ChartChromeModel["scale"] = null;
  const { platePad, plateHeight, textGap, plateAlpha } = latitudeScaleStyle;
  if (laidScale && visible("latitude-scale")) {
    const { x } = frame.screen(laidScale.x, view.y, flatMarkHeight);
    const ticks = laidScale.ticks.map((tick) => {
      const { y } = frame.screen(laidScale.x, tick.y, flatMarkHeight);
      const pad = laidScale.plated ? platePad : 0;
      const lineHeight = laidScale.plated ? plateHeight : marginNote.size;
      const left =
        x -
        textGap -
        metrics.measure(tick.text, marginNote.font) * marginNote.size -
        pad;
      return {
        key: tick.layer,
        label: {
          key: String(tick.layer),
          style: {
            ...lettering(
              marginNote.font,
              marginNote.size,
              inks.scale,
              marginNote.halo
            ),
            transform: position(
              left,
              y - (textScale * lineHeight) / 2,
              pixelRatio,
              textScale
            ),
          },
          text: tick.text,
        },
        y,
      };
    });
    scale = {
      bottom: Math.max(...ticks.map((tick) => tick.y)),
      opacity: laidScale.opacity,
      plated: laidScale.plated,
      ticks,
      top: Math.min(...ticks.map((tick) => tick.y)),
      x,
    };
  }
  const notes = visible("sea-caption")
    ? captionNotes(frame, metrics, { height, width }, textScale)
    : [];

  return {
    coordinates,
    frameVisible: visible("chart-frame"),
    geometry,
    height,
    notes,
    plateStyle: {
      "--spyglass-plate": `rgb(${channels(inks.labelHalo).join(" ")} / ${plateAlpha})`,
      "--spyglass-plate-height": `${plateHeight}px`,
      "--spyglass-plate-pad": `${platePad}px`,
    },
    scale,
    width,
  };
}

/** Scene animation may keep submitting frames; unchanged chrome produces no React update. */
export function createChromePresenter(
  publish: (model: ChartChromeModel) => void
) {
  let previous: readonly unknown[] = [];
  return (frame: Frame, metrics: TextMetrics) => {
    const { view } = frame;
    const origin = frame.screen(0, 0, flatMarkHeight);
    const keys = [
      frame.state.drawingData,
      frame.state.legendHeight,
      frame.state.settings.composition,
      frame.pixelRatio,
      view.x,
      view.y,
      view.width,
      view.height,
      view.pixelsPerUnit,
      view.tilt,
      origin.x,
      origin.y,
      ...(frame.exclusions ?? []).flatMap((rect) => [
        rect.left,
        rect.top,
        rect.right,
        rect.bottom,
      ]),
    ];
    if (
      keys.length === previous.length &&
      keys.every((key, index) => Object.is(key, previous[index]))
    ) {
      return;
    }
    previous = keys;
    publish(chartChromeModel(frame, metrics));
  };
}
