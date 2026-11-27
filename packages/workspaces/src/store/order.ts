import type { PageInput } from "@foundry/core/pagination";
import { byCodeUnit } from "@foundry/lib/ordering";
import type { WorkspaceEntry } from "../schema";
import type { EntryCountQuery, EntryPageQuery } from "./index";

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

function codePointRank(unit: number): number {
  if (unit >= 0xd8_00 && unit <= 0xdf_ff) {
    return unit + 0x20_00;
  }
  return unit >= 0xe0_00 ? unit - 0x08_00 : unit;
}

const byPath = byCodeUnit((entry: WorkspaceEntry) => entry.path);
const byEntryId = byCodeUnit((entry: WorkspaceEntry) => entry.id);

export function byPathThenId(a: WorkspaceEntry, b: WorkspaceEntry): number {
  return byPath(a, b) || byEntryId(a, b);
}

export function byCodePointPathThenId(
  a: WorkspaceEntry,
  b: WorkspaceEntry
): number {
  return byCodePoint(a.path, b.path) || byCodePoint(a.id, b.id);
}

export function pageOffset(cursor: number | undefined): number {
  if (cursor === undefined) {
    return 0;
  }
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new RangeError("Page cursor is invalid");
  }
  return cursor;
}

export function pageInputOf(
  input: PageInput<number> | undefined
): PageInput<number> {
  return input === undefined
    ? {}
    : { cursor: input.cursor, limit: input.limit };
}

export function entryPageQueryOf(
  input: EntryPageQuery | undefined
): EntryPageQuery {
  return input === undefined
    ? {}
    : {
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.type === undefined ? {} : { type: input.type }),
      };
}

export function entryCountQueryOf(
  query: EntryCountQuery | undefined
): EntryCountQuery {
  return query?.type === undefined ? {} : { type: query.type };
}
