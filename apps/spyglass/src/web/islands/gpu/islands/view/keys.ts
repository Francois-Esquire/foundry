export type KeyboardMode = "window" | "canvas" | false;

const FORM_TAGS = /^(INPUT|SELECT|TEXTAREA|BUTTON)$/;

interface ElementLike {
  closest: (selector: string) => unknown;
  isContentEditable?: boolean;
  tagName?: string;
}

const isElementLike = (target: unknown): target is ElementLike =>
  typeof target === "object" &&
  target !== null &&
  typeof (target as { closest?: unknown }).closest === "function";

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
  blur?: () => void;
  keydown?: (event: KeyboardEvent) => void;
  keyup?: (event: KeyboardEvent) => void;
}

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
