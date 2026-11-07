/**
 * Where the camera's and the selection's keys listen, and which key
 * presses they leave alone: one typed into a field, or pressed inside an
 * open dialog, belongs to that and not to the map.
 */

/**
 * Where the keys listen: the whole window, the canvas alone (made
 * focusable, so a click or Tab gives it the keys), or nowhere.
 */
export type KeyboardMode = "window" | "canvas" | false;

const FORM_TAGS = /^(INPUT|SELECT|TEXTAREA|BUTTON)$/;

/** What a key event's target offers, as an element does; anything else is no element. */
interface ElementLike {
  closest: (selector: string) => unknown;
  isContentEditable?: boolean;
  tagName?: string;
}

const isElementLike = (target: unknown): target is ElementLike =>
  typeof target === "object" &&
  target !== null &&
  typeof (target as { closest?: unknown }).closest === "function";

/**
 * Whether a key pressed at `target` is someone else's: the target is
 * editable (a field, a button, editable text) or inside an open `<dialog>`.
 * Duck-typed, so it holds for any element and is tested without a DOM.
 */
export function ignoresKeys(target: EventTarget | null): boolean {
  if (!isElementLike(target)) {
    return false;
  }
  return (
    target.isContentEditable === true ||
    FORM_TAGS.test(target.tagName ?? "") ||
    target.closest("dialog[open]") !== null
  );
}

export interface KeyHandlers {
  /** The keys were let go of without a keyup: the window or the canvas lost focus. */
  blur?: () => void;
  keydown?: (event: KeyboardEvent) => void;
  keyup?: (event: KeyboardEvent) => void;
}

/** Listens for keys where `mode` says; the returned function stops listening. */
export function listenKeys(
  canvas: HTMLCanvasElement,
  mode: KeyboardMode,
  handlers: KeyHandlers
): () => void {
  if (mode === false) {
    return () => undefined;
  }
  const target: EventTarget = mode === "canvas" ? canvas : window;
  const { blur, keydown, keyup } = handlers;
  const down = (event: Event) => keydown?.(event as KeyboardEvent);
  const up = (event: Event) => keyup?.(event as KeyboardEvent);
  const lost = () => blur?.();
  target.addEventListener("keydown", down);
  target.addEventListener("keyup", up);
  target.addEventListener("blur", lost);
  return () => {
    target.removeEventListener("keydown", down);
    target.removeEventListener("keyup", up);
    target.removeEventListener("blur", lost);
  };
}

/**
 * Makes the canvas focusable while the keys listen on it, unless the host
 * already set its `tabindex`; the returned function undoes only what this
 * did.
 */
export function focusableFor(
  canvas: HTMLCanvasElement,
  mode: KeyboardMode
): () => void {
  if (mode !== "canvas" || canvas.hasAttribute("tabindex")) {
    return () => undefined;
  }
  canvas.tabIndex = 0;
  return () => canvas.removeAttribute("tabindex");
}
