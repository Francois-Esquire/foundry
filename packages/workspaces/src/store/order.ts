import type { PageInput } from "@foundry/core/pagination";
import { byCodeUnit } from "@foundry/lib/ordering";
import type { WorkspaceEntry } from "../types";

/**
 * The orders both stores read in, kept here so they cannot drift apart.
 *
 * Registrations order by creation time, then by id in code-point order: the
 * order SQLite's `BINARY` collation gives text, as it compares UTF-8 bytes,
 * so the SQLite store can page in SQL. Code-point order differs from UTF-16
 * code-unit order only between U+E000–U+FFFF and characters past U+FFFF.
 *
 * Entries order by path in code-unit order, then by id. A valid tree has one
 * entry per path, so the id only settles entries a store was handed out of
 * the catalog's rules.
 */

/** Compares by Unicode code point, as SQLite compares UTF-8 text. */
export function byCodePoint(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.charCodeAt(index);
    const b = right.charCodeAt(index);
    if (a !== b) {
      return codePointRank(a) - codePointRank(b);
    }
  }
  return left.length - right.length;
}

/**
 * Lifts surrogates above U+E000–U+FFFF: a surrogate pair encodes a code
 * point past U+FFFF, which UTF-8 orders after every BMP character.
 */
function codePointRank(unit: number): number {
  if (unit >= 0xd8_00 && unit <= 0xdf_ff) {
    return unit + 0x20_00;
  }
  return unit >= 0xe0_00 ? unit - 0x08_00 : unit;
}

const byPath = byCodeUnit((entry: WorkspaceEntry) => entry.path);
const byEntryId = byCodeUnit((entry: WorkspaceEntry) => entry.id);

/** The order `listEntries` answers in. */
export function byPathThenId(a: WorkspaceEntry, b: WorkspaceEntry): number {
  return byPath(a, b) || byEntryId(a, b);
}

/**
 * The offset a `listWorkspaces` cursor names: absent is the start; anything
 * but a nonnegative safe integer is refused.
 */
export function pageOffset(cursor: number | undefined): number {
  if (cursor === undefined) {
    return 0;
  }
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new RangeError("Page cursor is invalid");
  }
  return cursor;
}

/**
 * A `listWorkspaces` input as it stands now: its cursor and limit, read
 * once when the read is called, so a caller changing its input while the
 * read waits its turn changes nothing. They are checked when the read runs.
 */
export function pageInputOf(
  input: PageInput<number> | undefined
): PageInput<number> {
  return input === undefined
    ? {}
    : { cursor: input.cursor, limit: input.limit };
}
