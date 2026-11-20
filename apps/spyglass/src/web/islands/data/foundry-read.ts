import type { Point } from "./chart";

export type Fields = Readonly<Record<string, unknown>>;

export const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const listOf = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];

export const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export const isNonNegative = (value: unknown): value is number =>
  isFiniteNumber(value) && value >= 0;

export const isText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export function readPoint(value: unknown): Point | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const [x, y]: readonly unknown[] = value;
  return isFiniteNumber(x) && isFiniteNumber(y) ? [x, y] : null;
}

export function readPlace(fields: Fields): Point | null {
  const { x, y } = fields;
  return isFiniteNumber(x) && isFiniteNumber(y) ? [x, y] : null;
}

export interface Notes {
  add: (line: string) => void;
  lines: () => string[];
}

export function createNotes(): Notes {
  const counts = new Map<string, number>();
  return {
    add: (line) => counts.set(line, (counts.get(line) ?? 0) + 1),
    lines: () =>
      [...counts].map(([line, count]) =>
        count > 1 ? `${line} (${count} times)` : line
      ),
  };
}
