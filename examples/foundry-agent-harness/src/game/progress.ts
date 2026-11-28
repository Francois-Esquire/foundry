import type { Scorecard } from "@/game/scorecard";

export interface Progress {
  readonly into: number;
  readonly level: number;
  readonly needed: number;
  readonly xp: number;
}

const PER_LEVEL = 100;

export function progressOf(scorecards: readonly Scorecard[]): Progress {
  const xp = scorecards.reduce((sum, card) => sum + card.total, 0);
  let level = 1;
  let into = xp;
  while (into >= PER_LEVEL * level) {
    into -= PER_LEVEL * level;
    level += 1;
  }
  return { into, level, needed: PER_LEVEL * level, xp };
}
