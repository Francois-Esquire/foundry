export const PORTRAIT_SIZES = {
  grand: { columns: 48, rows: 24 },
  large: { columns: 32, rows: 16 },
  medium: { columns: 24, rows: 12 },
  small: { columns: 16, rows: 8 },
} as const;

export type PortraitSize = keyof typeof PORTRAIT_SIZES;

export const HEALTH = [
  "fresh",
  "scuffed",
  "hurt",
  "battered",
  "critical",
] as const;

export type Health = (typeof HEALTH)[number];

export const POSES = [
  "smirk",
  "blink",
  "left",
  "right",
  "wince",
  "glow",
] as const;

export type Pose = (typeof POSES)[number];

export interface SpriteSheet {
  readonly cell: number;
  readonly file: string;
  readonly poses: readonly Pose[];
  readonly still: Partial<Record<Pose, readonly Health[]>>;
}
