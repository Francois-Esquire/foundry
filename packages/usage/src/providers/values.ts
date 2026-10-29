/** Readers for untyped client output: wrong-typed values read as absent. */

const MS_PER_SECOND = 1000;
/** A numeric time above this is milliseconds; below, seconds (until 2286). */
const EPOCH_MS_FLOOR = 1e12;

export const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

export const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** A token count: a finite number above zero, truncated; anything else is 0. */
export const count = (value: unknown): number =>
  finite(value) && value > 0 ? Math.trunc(value) : 0;

/** An ISO string, or epoch seconds (milliseconds when that large), as a date. */
export const dateFrom = (value: unknown): Date | undefined => {
  let ms: number | undefined;
  if (typeof value === "string") {
    ms = Date.parse(value);
  } else if (finite(value) && value > 0) {
    ms = value >= EPOCH_MS_FLOOR ? value : value * MS_PER_SECOND;
  }
  return ms !== undefined && Number.isFinite(ms) ? new Date(ms) : undefined;
};

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** `promise`, or a rejection with `message` after `ms`. */
export const within = async <T>(
  promise: Promise<T>,
  ms: number,
  message: string
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
};
