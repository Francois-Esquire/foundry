/** What a key press means on the glyph drawing. */

export type CanvasCommand =
  | { readonly kind: "nudge"; readonly dx: number; readonly dy: number }
  | { readonly kind: "pan"; readonly dx: number; readonly dy: number }
  | {
      readonly kind: "step";
      readonly direction: -1 | 1;
      readonly extend: boolean;
    }
  | { readonly kind: "zoom"; readonly factor: number }
  | {
      readonly kind:
        | "clear"
        | "delete"
        | "fit"
        | "redo"
        | "select-all"
        | "undo";
    };

export interface KeyPress {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly key: string;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

/** Font units an arrow key moves the selection with Shift held. */
const LARGE_NUDGE = 10;
/** Screen pixels an arrow key moves the drawing with Alt held. */
const PAN_STEP = 40;
export const ZOOM_STEP = 1.25;

const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowDown: [0, -1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, 1],
};

const withCommandKey = ({
  key,
  shiftKey,
}: KeyPress): CanvasCommand | undefined => {
  switch (key.toLowerCase()) {
    case "a":
      return { kind: "select-all" };
    case "y":
      return { kind: "redo" };
    case "z":
      return { kind: shiftKey ? "redo" : "undo" };
    default:
      return;
  }
};

const withArrow = (
  [x, y]: readonly [number, number],
  { altKey, shiftKey }: KeyPress
): CanvasCommand => {
  if (altKey) {
    // The drawing moves with the arrow. Screen y points down, font y up.
    return { dx: x * PAN_STEP, dy: -y * PAN_STEP, kind: "pan" };
  }
  const distance = shiftKey ? LARGE_NUDGE : 1;
  return { dx: x * distance, dy: y * distance, kind: "nudge" };
};

/** The command for a key press, or undefined when the drawing has no use for the key. */
export const commandForKey = (press: KeyPress): CanvasCommand | undefined => {
  if (press.ctrlKey || press.metaKey) {
    return withCommandKey(press);
  }
  const arrow = ARROWS[press.key];
  if (arrow) {
    return withArrow(arrow, press);
  }
  switch (press.key) {
    case "PageDown":
      return { direction: 1, extend: press.shiftKey, kind: "step" };
    case "PageUp":
      return { direction: -1, extend: press.shiftKey, kind: "step" };
    case "Delete":
    case "Backspace":
      return { kind: "delete" };
    case "Escape":
      return { kind: "clear" };
    case "+":
    case "=":
      return { factor: ZOOM_STEP, kind: "zoom" };
    case "-":
    case "_":
      return { factor: 1 / ZOOM_STEP, kind: "zoom" };
    case "0":
      return { kind: "fit" };
    default:
      return;
  }
};
