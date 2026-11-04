import type { KeyboardEvent } from "react";

/** How focusable items are laid out. */
interface FocusLayout {
  /** Items per row; without it, one column that moves only up and down. */
  readonly columns?: number;
  /** Past either end, continue from the other; otherwise stop there. */
  readonly wrap?: boolean;
}

/**
 * Moves focus from the event's item among `items` for a navigation key:
 * the arrows by one item (up and down by a row in a grid), Home and End to
 * either end. Any other key passes through. Every item stays in the Tab
 * order; this only adds the keys.
 */
export function moveFocusAmong(
  event: KeyboardEvent<HTMLElement>,
  items: readonly HTMLElement[],
  { columns, wrap = false }: FocusLayout = {}
): void {
  const count = items.length;
  const index = items.indexOf(event.currentTarget);
  const row = columns ?? 1;
  const steps: Readonly<Record<string, number>> = {
    ArrowDown: row,
    ArrowUp: -row,
    ...(columns === undefined ? {} : { ArrowLeft: -1, ArrowRight: 1 }),
  };
  let target: number;
  if (event.key === "Home") {
    target = 0;
  } else if (event.key === "End") {
    target = count - 1;
  } else {
    const step = steps[event.key];
    if (step === undefined || index === -1) {
      return;
    }
    target = wrap
      ? (((index + step) % count) + count) % count
      : Math.min(Math.max(index + step, 0), count - 1);
  }
  const item = items[target];
  if (item) {
    event.preventDefault();
    item.focus();
  }
}
