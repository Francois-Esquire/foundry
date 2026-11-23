export const PORTRAIT_SIZES = {
  large: { columns: 32, rows: 16 },
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

export const POSES = ["blink", "left", "right", "wince", "glow"] as const;

export type Pose = (typeof POSES)[number];

export interface SpriteSheet {
  readonly cell: number;
  readonly file: string;
  readonly poses: readonly Pose[];
  readonly still: Partial<Record<Pose, readonly Health[]>>;
}
