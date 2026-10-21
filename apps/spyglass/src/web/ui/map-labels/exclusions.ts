/** A rectangle in host-local CSS pixels. */
export interface ScreenRect {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

/** Measure the actual responsive controls before writing this frame's labels. */
export function screenExclusions(host: HTMLElement): ScreenRect[] {
  const shell = host.closest(".spyglass-shell");
  if (!shell) {
    return [];
  }
  const origin = host.getBoundingClientRect();
  const exclusions: ScreenRect[] = [];
  const elements = shell.querySelectorAll<HTMLElement>(
    ".spyglass-app-bar, .spyglass-bottom-bar"
  );
  for (const element of elements) {
    const rect = element.getBoundingClientRect();
    if (element.hidden || rect.width <= 0 || rect.height <= 0) {
      continue;
    }
    exclusions.push({
      bottom: rect.bottom - origin.top + 6,
      left: rect.left - origin.left - 6,
      right: rect.right - origin.left + 6,
      top: rect.top - origin.top - 6,
    });
  }
  return exclusions;
}
