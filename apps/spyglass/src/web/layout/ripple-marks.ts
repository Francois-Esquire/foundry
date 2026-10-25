import { inkAlpha, inks } from "../ladder/ink-ladder";
import type { Stroke } from "./marks";
import { runPoints } from "./marks";
import { penWeights } from "./pen-runs";
import type { SeaRipple } from "./sea-ripples";

/** Pen width at unit pressure, in CSS pixels. */
const ripplePen = 0.7;

/**
 * Each ripple level's alpha: the level's strength, surfacing as the camera
 * comes in. One function per level, shared by every ripple of that level,
 * so the renderer keeps one batch per level and weight.
 */
const rippleAlpha = inkAlpha.ripple.map(
  (strength) => (pixels: number) => inkAlpha.rippleReveal(pixels) * strength
);

/**
 * Barely-there gilt water lines off every coast, flat on the sea: one stroke
 * per pen run, weighted by the pen's pressure. The ripples are the chart's
 * fixed geometry, so these are built once.
 */
export function seaRippleMarks(ripples: readonly SeaRipple[]): Stroke[] {
  const marks: Stroke[] = [];
  for (const ripple of ripples) {
    const alpha = rippleAlpha[ripple.level];
    if (alpha === undefined) {
      continue;
    }
    for (const [weight, runs] of ripple.buckets.entries()) {
      const width = ripplePen * (penWeights[weight] ?? 1);
      for (const run of runs) {
        marks.push({
          alpha,
          cap: "round",
          colour: inks.ripple,
          kind: "stroke",
          points: runPoints(run),
          width,
        });
      }
    }
  }
  return marks;
}
