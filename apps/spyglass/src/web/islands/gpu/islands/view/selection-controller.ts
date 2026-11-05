/** Browser selection lifecycle: gestures, queued GPU picks and throttled readouts. */
import type { Frame } from "vgpu";
import type { Chart } from "../../../data/chart";
import type { MapSource } from "../maps/maps";
import type { Banks } from "../sea/banks";
import type { View } from "./camera";
import { ignoresKeys, type KeyboardMode, listenKeys } from "./keys";
import type { Picker, PickMode } from "./pick";
import {
	type Chosen,
	type Described,
	describe,
	keptChosen,
	sameChosen,
} from "./selection";

/** A press moving farther than this many CSS pixels is a drag. */
const CLICK_SLOP = 4;
/** Read the GPU selection back at most this often, ms. */
const READ_INTERVAL = 120;

export interface SelectionController {
	/**
	 * Chooses outright, as a click would but by id (selection.ts
	 * `chosenOf`). Like a click it is ignored while picking is off, except
	 * letting go, and choosing what is already chosen does nothing.
	 */
	choose: (chosen: Chosen) => void;
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
}

/** Owns the picker's lifetime along with its browser listeners and readback timer. */
export function createSelectionController(
	canvas: HTMLCanvasElement,
	picker: Pick<Picker, "choose" | "pick" | "read" | "dispose">,
	options: SelectionOptions
): SelectionController {
	const { onChange, onDirty, onError } = options;
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
				const next = keptChosen(chosen, read.chosen, clicked);
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
					selected: describe(chart, banks, chosen),
					hovered: describe(chart, banks, hovered),
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
			if (disposed || !allowed || sameChosen(chosen, next)) {
				return;
			}
			choices += 1;
			chosen = next;
			picker.choose(chosen, hovered);
			onChange({
				selected: describe(chart, banks, chosen),
				hovered: describe(chart, banks, hovered),
			});
			onDirty();
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
