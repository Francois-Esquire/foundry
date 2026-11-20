import type { Frame } from "vgpu";
import type { Chart } from "../../../data/chart";
import type { MapSource } from "../maps/maps";
import type { Banks } from "../sea/banks";
import type { BuildingIndex } from "./building-at";
import type { View } from "./camera";
import { ignoresKeys, type KeyboardMode, listenKeys } from "./keys";
import type { Picker, PickMode } from "./pick";
import {
  type Chosen,
  coveredBy,
  type Described,
  describe,
  keptChosen,
  sameChosen,
} from "./selection";

const CLICK_SLOP = 4;
const READ_INTERVAL = 120;
const BUILDING_PIXELS = 4;

export interface SelectionController {
  choose: (chosen: Chosen) => boolean;
  dispose: () => void;
  encode: (frame: Frame, view: View, maps: MapSource) => void;
  setChart: (chart: Chart, banks: Banks) => void;
  setEnabled: (enabled: boolean) => void;
  setKeyboard: (keyboard: KeyboardMode) => void;
}

interface SelectionOptions {
  banks: Banks;
  buildings: () => BuildingIndex | null;
  chart: Chart;
  enabled: boolean;
  keyboard?: KeyboardMode;
  onChange: (selection: {
    selected: Described | null;
    hovered: Described | null;
  }) => void;
  onDirty: () => void;
  onError: (error: unknown) => void;
  pixelsPerUnit: (at: readonly [number, number]) => number;
}

export function createSelectionController(
  canvas: HTMLCanvasElement,
  picker: Pick<Picker, "choose" | "pick" | "read" | "dispose">,
  options: SelectionOptions
): SelectionController {
  const { buildings, onChange, onDirty, onError, pixelsPerUnit } = options;
  const buildingOf = (id: number) => buildings()?.byId(id);
  const described = (thing: Chosen) =>
    describe(chart, banks, thing, buildingOf);
  let { banks, chart, enabled } = options;
  let disposed = false;
  let drawnView: View | null = null;
  let chosen: Chosen = null;
  let hovered: Chosen = null;
  let reading = false;
  let stale = false;
  let readAt = 0;
  let choices = 0;
  let readLater: ReturnType<typeof setTimeout> | undefined;
  let picked = false;
  const readBack = () => {
    if (reading) {
      stale = true;
      return;
    }
    const wait = readAt + READ_INTERVAL - performance.now();
    if (wait > 0) {
      readLater ??= setTimeout(() => {
        readLater = undefined;
        readBack();
      }, wait);
      return;
    }
    reading = true;
    stale = false;
    readAt = performance.now();
    const begun = choices;
    const clicked = picked;
    picked = false;
    picker
      .read()
      .then((read) => {
        if (begun !== choices) {
          stale = true;
          picked ||= clicked;
          return;
        }
        const next = landedOn(
          keptChosen(chosen, read.chosen, clicked),
          read.chosenAt,
          clicked
        );
        if (
          disposed ||
          (sameChosen(chosen, next) && sameChosen(hovered, read.hovered))
        ) {
          return;
        }
        chosen = next;
        ({ hovered } = read);
        canvas.style.cursor = hovered ? "pointer" : "";
        onChange({
          hovered: described(hovered),
          selected: described(chosen),
        });
      })
      .catch(onError)
      .finally(() => {
        reading = false;
        if (stale) {
          readBack();
        }
      });
  };
  const landedOn = (
    next: Chosen,
    at: readonly [number, number],
    clicked: boolean
  ): Chosen => {
    if (!clicked || next?.kind !== "island") {
      return next;
    }
    const building = buildings()?.at(next.island, at);
    const across = building
      ? 2 * Math.min(building.half[0], building.half[1]) * pixelsPerUnit(at)
      : 0;
    return building && across >= BUILDING_PIXELS
      ? { building: building.id, island: next.island, kind: "building" }
      : next;
  };
  let picks: { mode: PickMode; uv: [number, number] }[] = [];
  const pickAt = (mode: PickMode, event?: PointerEvent) => {
    const letting = mode === "letGo" || mode === "leave";
    if (!(enabled || letting) || disposed) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const uv: [number, number] = event
      ? [
          (event.clientX - rect.left) / Math.max(rect.width, 1),
          (event.clientY - rect.top) / Math.max(rect.height, 1),
        ]
      : [0, 0];
    if (mode === "hover") {
      picks = picks.filter((p) => p.mode !== "hover");
    }
    picks.push({ mode, uv });
    onDirty();
  };
  let pressedAt: { x: number; y: number } | null = null;
  const onDown = (event: PointerEvent) => {
    pressedAt =
      event.button === 0 && !event.shiftKey
        ? { x: event.clientX, y: event.clientY }
        : null;
  };
  const onMove = (event: PointerEvent) => {
    if (event.buttons === 0) {
      pickAt("hover", event);
    }
  };
  const onUp = (event: PointerEvent) => {
    const at = pressedAt;
    pressedAt = null;
    if (
      at &&
      Math.hypot(event.clientX - at.x, event.clientY - at.y) <= CLICK_SLOP
    ) {
      pickAt("choose", event);
    }
  };
  const onLeave = () => pickAt("leave");
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !ignoresKeys(event.target)) {
      pickAt("letGo");
    }
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointerleave", onLeave);
  let unlisten = listenKeys(canvas, options.keyboard ?? "window", {
    keydown: onKey,
  });

  return {
    choose(next) {
      const allowed = enabled || next === null;
      if (
        disposed ||
        !allowed ||
        sameChosen(chosen, next) ||
        coveredBy(chart, chosen, next, buildingOf)
      ) {
        return false;
      }
      choices += 1;
      chosen = next;
      picker.choose(chosen, hovered);
      onChange({
        hovered: described(hovered),
        selected: described(chosen),
      });
      onDirty();
      return true;
    },
    dispose() {
      disposed = true;
      clearTimeout(readLater);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      unlisten();
      picker.dispose();
    },
    encode(frame, view, maps) {
      if (picks.length > 0 && drawnView) {
        for (const { mode, uv } of picks) {
          picker.pick(frame, mode, drawnView, uv, maps);
          picked ||= mode === "choose" || mode === "letGo";
        }
        picks = [];
        queueMicrotask(readBack);
      }
      drawnView = view;
    },
    setChart(nextChart, nextBanks) {
      chart = nextChart;
      banks = nextBanks;
      picks = [];
      choices += 1;
      const held = chosen !== null || hovered !== null;
      chosen = null;
      hovered = null;
      picker.choose(null, null);
      canvas.style.cursor = "";
      if (held) {
        onChange({ hovered: null, selected: null });
      }
      onDirty();
    },
    setEnabled(next) {
      const stopped = enabled && !next;
      enabled = next;
      if (stopped) {
        pickAt("letGo");
        pickAt("leave");
      }
    },
    setKeyboard(keyboard) {
      unlisten();
      unlisten = listenKeys(canvas, keyboard, { keydown: onKey });
    },
  };
}
