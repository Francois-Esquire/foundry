import type { CalendarSlot, Trigger } from "~/lib/triggers";

export const DEFAULT_EVERY = "60s";

const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000, ms: 1, s: 1000 };
const EVERY = /^(\d+)\s*(ms|s|m|h|d)$/;

function durationMs(text: string): number | undefined {
  const match = EVERY.exec(text.trim());
  if (!match) {
    return undefined;
  }
  const amount = Number(match[1]);
  const unit = match[2] as keyof typeof UNIT_MS;
  return amount * UNIT_MS[unit];
}

export function parseEvery(every: string): number {
  const ms = durationMs(every);
  if (ms === undefined) {
    throw new Error(`cannot read cadence "${every}" (want e.g. 30m, 6h, 1d)`);
  }
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw new Error(
      `cadence "${every}" must be a positive interval that fits in a safe integer`
    );
  }
  return ms;
}

function inRange(value: number, max: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= max;
}

export function parseAt(at: string | CalendarSlot): Trigger {
  if (typeof at === "string") {
    return { kind: "interval", ms: parseEvery(at) };
  }
  const minute = at.minute ?? 0;
  if (!(inRange(at.hour, 23) && inRange(minute, 59))) {
    throw new Error(
      `cannot read calendar slot ${JSON.stringify(at)} (want hour 0–23, minute 0–59)`
    );
  }
  return { kind: "calendar", slot: { ...at, minute } };
}

export function timeoutMs(timeout: number | string): number {
  if (typeof timeout === "number") {
    if (!(Number.isSafeInteger(timeout) && timeout > 0)) {
      throw new Error(
        `a timeout must be a positive number of milliseconds, not ${timeout}`
      );
    }
    return timeout;
  }
  return parseEvery(timeout);
}
