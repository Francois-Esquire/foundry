import type { KeyboardEvent } from "react";

interface FocusLayout {
  readonly columns?: number;
  readonly wrap?: boolean;
}

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
