import stringWidth from "string-width";

/** Terminal cells, ignoring ANSI escapes. Never use `.length` for layout. */
export function displayWidth(text: string): number {
  return stringWidth(text);
}

export function padDisplay(text: string, width: number): string {
  const gap = width - displayWidth(text);
  return gap > 0 ? `${text}${" ".repeat(gap)}` : text;
}

/** Keeps the start of the text and appends `ellipsis` when it does not fit. */
export function truncateDisplay(
  text: string,
  width: number,
  ellipsis: string
): string {
  if (displayWidth(text) <= width) {
    return text;
  }
  let kept = "";
  for (const char of text) {
    if (displayWidth(`${kept}${char}${ellipsis}`) > width) {
      break;
    }
    kept += char;
  }
  return `${kept}${ellipsis}`;
}
