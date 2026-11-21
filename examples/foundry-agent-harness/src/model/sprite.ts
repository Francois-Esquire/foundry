export const PORTRAIT_COLUMNS = 32;
export const PORTRAIT_ROWS = 16;

export const HEALTH = [
  "fresh",
  "scuffed",
  "hurt",
  "battered",
  "critical",
] as const;

export type Health = (typeof HEALTH)[number];

export const POSES = ["blink", "left", "right", "wince", "glow"] as const;

export type Pose = (typeof POSES)[number];

export interface SpriteSheet {
  readonly cell: number;
  readonly file: string;
  readonly poses: readonly Pose[];
  readonly still: Partial<Record<Pose, readonly Health[]>>;
}

const REMAINING = [0.8, 0.6, 0.4, 0.2];

export function healthAt(used: number): Health {
  const step = REMAINING.findIndex((floor) => 1 - used >= floor);
  return HEALTH[step < 0 ? HEALTH.length - 1 : step] ?? "critical";
}
