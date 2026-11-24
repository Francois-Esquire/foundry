import {
  integer,
  SQLiteSyncDialect,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { describe, expect, test } from "vitest";
import {
  assertScope,
  batches,
  describeNumber,
  excluded,
  joinFieldPath,
  RecordFault,
  replacing,
  SQLITE_MAX_PARAMETERS,
  storableNumber,
  storableText,
  UNSTORABLE_TEXT,
  whyUnstorable,
} from "../sqlite";

const items = sqliteTable("items", {
  count: integer("item_count").notNull(),
  id: text("id").notNull(),
  scope: text("scope").notNull(),
});

const dialect = new SQLiteSyncDialect();

describe("storableText", () => {
  test("accepts well-formed text without U+0000", () => {
    expect(storableText("")).toBe(true);
    expect(storableText("plain text \u{1f600}")).toBe(true);
  });

  test("refuses U+0000, lone surrogates and non-strings", () => {
    expect(storableText("a\u0000b")).toBe(false);
    expect(storableText("\ud800")).toBe(false);
    expect(storableText("x\udc00")).toBe(false);
    expect(storableText(1)).toBe(false);
    expect(storableText(undefined)).toBe(false);
  });
});

describe("storableNumber", () => {
  test("accepts numbers within the safe integer range, fractions included", () => {
    expect(storableNumber(0)).toBe(true);
    expect(storableNumber(1.5)).toBe(true);
    expect(storableNumber(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(storableNumber(-Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  test("refuses -0, NaN, infinities and unsafe magnitudes", () => {
    expect(storableNumber(-0)).toBe(false);
    expect(storableNumber(Number.NaN)).toBe(false);
    expect(storableNumber(Number.POSITIVE_INFINITY)).toBe(false);
    expect(storableNumber(Number.MAX_SAFE_INTEGER + 2)).toBe(false);
  });
});

test("describeNumber spells -0 apart from 0", () => {
  expect(describeNumber(-0)).toBe("-0");
  expect(describeNumber(0)).toBe("0");
  expect(describeNumber(Number.NaN)).toBe("NaN");
});

describe("whyUnstorable", () => {
  test("names unstorable text", () => {
    expect(whyUnstorable("a\u0000", "text")).toBe(UNSTORABLE_TEXT);
    expect(UNSTORABLE_TEXT).toBe(
      "text holding U+0000 or a lone surrogate (not well-formed UTF-16) does not read back intact from SQLite"
    );
    expect(whyUnstorable("fine", "text")).toBeUndefined();
    expect(whyUnstorable(undefined, "text")).toBeUndefined();
  });

  test("names an invalid Date", () => {
    expect(whyUnstorable(new Date(Number.NaN), "time")).toBe(
      "a time that is not a valid Date has no epoch milliseconds to store"
    );
    expect(whyUnstorable(new Date(0), "time")).toBeUndefined();
    expect(whyUnstorable(undefined, "time")).toBeUndefined();
  });

  test("names integers SQLite does not keep", () => {
    const reason =
      "SQLite keeps an integer column as a safe integer, and reads -0 back as 0";
    expect(whyUnstorable(-0, "integer")).toBe(reason);
    expect(whyUnstorable(1.5, "integer")).toBe(reason);
    expect(whyUnstorable(Number.MAX_SAFE_INTEGER + 1, "integer")).toBe(reason);
    expect(whyUnstorable(7, "integer")).toBeUndefined();
    expect(whyUnstorable("7", "integer")).toBeUndefined();
  });
});

describe("assertScope", () => {
  test("accepts a nonempty storable scope", () => {
    expect(() => assertScope("tenant")).not.toThrow();
  });

  test.each(["", "a\u0000", "\ud800"])("refuses %j", (scope) => {
    expect(() => assertScope(scope)).toThrow(
      new RangeError(
        "scope must be a nonempty string with no U+0000 and no lone surrogate"
      )
    );
  });
});

describe("batches", () => {
  test("splits items into runs of the given size", () => {
    expect(batches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  test("rounds a fractional size down", () => {
    expect(batches([1, 2, 3, 4], 2.9)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  test("treats a size below one as one", () => {
    expect(batches([1, 2], 0)).toEqual([[1], [2]]);
    expect(batches([1, 2], 0.5)).toEqual([[1], [2]]);
  });

  test("rejects a NaN size", () => {
    expect(() => batches([1, 2], Number.NaN)).toThrow(
      new RangeError("batch size must not be NaN")
    );
  });

  test("yields nothing for no items", () => {
    expect(batches([], 10)).toEqual([]);
  });

  test("keeps the SQLite bound parameter limit", () => {
    expect(SQLITE_MAX_PARAMETERS).toBe(32_766);
  });
});

describe("upsert helpers", () => {
  test("excluded names the column as SQLite stores it", () => {
    expect(dialect.sqlToQuery(excluded(items.count)).sql).toBe(
      'excluded."item_count"'
    );
    const quoted = sqliteTable("quoted", {
      weird: text('a"b').notNull(),
    });
    expect(dialect.sqlToQuery(excluded(quoted.weird)).sql).toBe(
      'excluded."a""b"'
    );
  });

  test("replacing maps every column outside the preserved columns to its excluded value", () => {
    const set = replacing(
      { count: items.count, id: items.id, scope: items.scope },
      [items.id, items.scope]
    );
    expect(
      Object.entries(set).map(([field, value]) => [
        field,
        dialect.sqlToQuery(value).sql,
      ])
    ).toEqual([["count", 'excluded."item_count"']]);
  });

  test("replacing without a key replaces every column", () => {
    expect(
      Object.keys(replacing({ count: items.count, id: items.id }))
    ).toEqual(["count", "id"]);
  });
});

describe("record faults", () => {
  test("RecordFault keeps its path and reason", () => {
    const fault = new RecordFault("links[0]", "holds a number, not text");
    expect(fault).toBeInstanceOf(Error);
    expect(fault.name).toBe("RecordFault");
    expect(fault.path).toBe("links[0]");
    expect(fault.reason).toBe("holds a number, not text");
    expect(fault.message).toBe("links[0]: holds a number, not text");
  });

  test("RecordFault names the whole record when the path is empty", () => {
    expect(new RecordFault("", "is not an object").message).toBe(
      "(record): is not an object"
    );
  });

  test("joinFieldPath joins a field path under a location", () => {
    expect(joinFieldPath("putRuns[0]", "")).toBe("putRuns[0]");
    expect(joinFieldPath("putRuns[0]", "links")).toBe("putRuns[0].links");
    expect(joinFieldPath("putRuns[0]", '["a b"]')).toBe('putRuns[0]["a b"]');
    expect(joinFieldPath("putRuns[0]", "[2].id")).toBe("putRuns[0][2].id");
  });
});
