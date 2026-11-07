/** Browser selection lifecycle: gestures, queued GPU picks and throttled readouts. */
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

/** A press moving farther than this many CSS pixels is a drag. */
const CLICK_SLOP = 4;
/** Read the GPU selection back at most this often, ms. */
const READ_INTERVAL = 120;
/**
 * The fewest CSS pixels a building's narrower side must span for a click to
 * name it rather than its island: from afar a town's houses are specks, and
 * a click there means the island.
 */
const BUILDING_PIXELS = 4;

export interface SelectionController {
	/**
	 * Chooses outright, as a click would but by id (selection.ts
	 * `chosenOf`). Like a click it is ignored while picking is off, except
	 * letting go, and choosing what is already chosen does nothing; nor does
	 * naming again the island or a file of the building chosen.
	 */
	/** False when it changed nothing. */
	choose: (chosen: Chosen) => boolean;
	dispose: () => void;
	/** Pick the previous film before drawing the new view into it. */
	encode: (frame: Frame, view: View, maps: MapSource) => void;
	/**
	 * A new chart: the chosen and the hovered are let go, since their
	 * indices name nothing in it.
	 */
	setChart: (chart: Chart, banks: Banks) => void;
	setEnabled: (enabled: boolean) => void;
	/** Where Escape listens (keys.ts). */
	setKeyboard: (keyboard: KeyboardMode) => void;
}

interface SelectionOptions {
	banks: Banks;
	/**
	 * The world plan's buildings, as the latest plan stands: a click on land
	 * names the building whose footprint it falls on. Null before a plan.
	 */
	buildings: () => BuildingIndex | null;
	chart: Chart;
	enabled: boolean;
	/** Where Escape listens (keys.ts); "window" by default. */
	keyboard?: KeyboardMode;
	onChange: (selection: {
		selected: Described | null;
		hovered: Described | null;
	}) => void;
	onDirty: () => void;
	onError: (error: unknown) => void;
	/** CSS pixels a chart unit spans at a chart point, as the camera stands now (`Islands.pixelsPerUnit`). */
	pixelsPerUnit: (at: readonly [number, number]) => number;
}

/** Owns the picker's lifetime along with its browser listeners and readback timer. */
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
	// Counts the choices made outright: a read begun before one is stale.
	let choices = 0;
	let readLater: ReturnType<typeof setTimeout> | undefined;
	// Set once a click or Escape is encoded: the next read may change a
	// chosen module, which the GPU only knows as its island.
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
					selected: described(chosen),
					hovered: described(hovered),
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
	// A click on land names the building it fell on, when one stands there
	// and is big enough on screen to aim at; the GPU only knows the island.
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
			? { kind: "building", island: next.island, building: building.id }
			: next;
	};
	// Picks wait for the next frame, which encodes them at its head: a
	// hover replaces the one waiting, so a frame picks once however
	// fast the pointer moves.
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
				selected: described(chosen),
				hovered: described(hovered),
			});
			onDirty();
			return true;
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
				onChange({ selected: null, hovered: null });
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
	};
}
