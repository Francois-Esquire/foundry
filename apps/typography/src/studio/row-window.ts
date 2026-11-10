/** Which rows of a long list are on screen, so only those are rendered. */

export interface RowWindowInput {
  readonly count: number;
  /** Rows kept ready above and below the visible ones. */
  readonly overscan?: number;
  readonly rowHeight: number;
  readonly scrollTop: number;
  readonly viewportHeight: number;
}

export interface RowWindow {
  /** Index of the first row to render. */
  readonly first: number;
  /** One past the last row to render. */
  readonly last: number;
  /** Space to leave above the first rendered row, in pixels. */
  readonly offset: number;
  /** The height of the whole list, in pixels. */
  readonly totalHeight: number;
}

export const rowWindow = ({
  count,
  overscan = 4,
  rowHeight,
  scrollTop,
  viewportHeight,
}: RowWindowInput): RowWindow => {
  const totalHeight = count * rowHeight;
  const top = Math.min(
    Math.max(0, scrollTop),
    Math.max(0, totalHeight - viewportHeight)
  );
  const first = Math.max(0, Math.floor(top / rowHeight) - overscan);
  const last = Math.min(
    count,
    Math.ceil((top + viewportHeight) / rowHeight) + overscan
  );
  return { first, last, offset: first * rowHeight, totalHeight };
};

/** The scroll position that brings a row into view, or the current one when it already is. */
export const scrollToRow = (
  index: number,
  { rowHeight, scrollTop, viewportHeight }: Omit<RowWindowInput, "count">
) => {
  const top = index * rowHeight;
  if (top < scrollTop) {
    return top;
  }
  const bottom = top + rowHeight;
  return bottom > scrollTop + viewportHeight
    ? bottom - viewportHeight
    : scrollTop;
};
