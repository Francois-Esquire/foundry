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

/** Rows include one extra item to establish whether a continuation exists. */
export function pageFromRows<T, Cursor>(
  rows: readonly T[],
  limit: number,
  total: number,
  cursor: (item: T) => Cursor
): Page<T, Cursor> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    total,
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
  total: number,
  hydrate: (row: Row) => Item
): Page<Item, number> {
  const items = rows.slice(0, limit).map(hydrate);
  return {
    items,
    total,
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

export async function collectPages<T, Cursor>(
  read: (cursor: Cursor | undefined) => Promise<Page<T, Cursor>>
): Promise<T[]> {
  const items: T[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await read(cursor);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return items;
}
