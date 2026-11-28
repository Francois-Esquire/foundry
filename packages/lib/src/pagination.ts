import type { Page, PageInput } from "@foundry/core/pagination";

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

export function pageLimit(
  value: number | undefined,
  {
    fallback = DEFAULT_PAGE_LIMIT,
    max = MAX_PAGE_LIMIT,
  }: { fallback?: number; max?: number } = {}
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("Page limit must be a positive safe integer");
  }
  return Math.min(value, max);
}

export function pageFromRows<T, Cursor>(
  rows: readonly T[],
  limit: number,
  total: number | undefined,
  cursor: (item: T) => Cursor
): Page<T, Cursor> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    ...(total === undefined ? {} : { total }),
    ...(rows.length > limit && last !== undefined
      ? { nextCursor: cursor(last) }
      : {}),
  };
}

export function pageAfter<T>(
  values: readonly T[],
  input: PageInput,
  identity: (value: T) => string
): Page<T> {
  const limit = pageLimit(input.limit);
  const start =
    input.cursor === undefined
      ? 0
      : values.findIndex((value) => identity(value) === input.cursor) + 1;
  if (start === 0 && input.cursor !== undefined) {
    throw new RangeError("Page cursor is invalid");
  }
  return pageFromRows(
    values.slice(start, start + limit + 1),
    limit,
    values.length,
    identity
  );
}

export function buildPage<Row, Item>(
  rows: readonly Row[],
  limit: number,
  offset: number,
  total: number | undefined,
  hydrate: (row: Row) => Item
): Page<Item, number> {
  const items = rows.slice(0, limit).map(hydrate);
  return {
    items,
    ...(total === undefined ? {} : { total }),
    ...(rows.length > limit ? { nextCursor: offset + items.length } : {}),
  };
}

export function sliceRanked<T>(
  ranked: readonly T[],
  limit: number,
  offset: number
): Page<T, number> {
  return buildPage(
    ranked.slice(offset, offset + limit + 1),
    limit,
    offset,
    ranked.length,
    (item) => item
  );
}

export function emptyPage<T>(): Page<T, number> {
  return { items: [], total: 0 };
}

export interface CollectPagesOptions {
  readonly maxItems?: number;
  readonly maxPages?: number;
  readonly signal?: AbortSignal;
}

function assertPositiveBound(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

export async function collectPages<T, Cursor>(
  read: (cursor: Cursor | undefined) => Promise<Page<T, Cursor>>,
  options: CollectPagesOptions = {}
): Promise<T[]> {
  assertPositiveBound(options.maxItems, "maxItems");
  assertPositiveBound(options.maxPages, "maxPages");
  const items: T[] = [];
  let cursor: Cursor | undefined;
  let pages = 0;
  do {
    options.signal?.throwIfAborted();
    if (options.maxPages !== undefined && pages >= options.maxPages) {
      throw new RangeError(
        `collectPages exceeded maxPages limit (${String(options.maxPages)})`
      );
    }
    const page = await read(cursor);
    options.signal?.throwIfAborted();
    pages += 1;
    if (
      options.maxItems !== undefined &&
      items.length + page.items.length > options.maxItems
    ) {
      throw new RangeError(
        `collectPages exceeded maxItems limit (${String(options.maxItems)})`
      );
    }
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return items;
}
