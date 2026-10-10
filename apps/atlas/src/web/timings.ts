/**
 * The viewer's load, and the stages of each map repaint, as Performance API
 * entries: DevTools shows them as user timings, and `scripts/capture.ts`
 * reads them with its `marks` step.
 */

/** Named points in the load, in the order they happen. */
export const loadMarks = [
  "atlas:data-requested",
  "atlas:data-loaded",
  "atlas:layout-settled",
  "atlas:terrain-built",
  "atlas:first-frame",
] as const;

export type LoadMark = (typeof loadMarks)[number];

const recorded = new Set<LoadMark>();

/**
 * Records one point in the load, once per page: a scene built again, after a
 * layout change, adds no second mark.
 */
export function markLoad(mark: LoadMark): void {
  if (recorded.has(mark)) {
    return;
  }
  recorded.add(mark);
  performance.mark(mark);
}

/** The stages of one map repaint, each measured as `atlas:paint:<stage>`. */
export type PaintStage =
  | "boundaries"
  | "ink"
  | "lettering"
  | "relief"
  | "sea-ink";

/**
 * What a developer session times: each repaint's stages, and
 * `render-submit`, measured as `atlas:render-submit`: the CPU time to encode
 * and submit one frame, for every frame submitted, whether a repaint asked
 * for it or not. GPU time is not measured.
 */
export type TimedStage = PaintStage | "render-submit";

/**
 * Measures kept per stage. When a stage reaches the cap its measures are
 * cleared and counting starts again, so each stage holds between 1 and 240
 * of its latest durations and a long session stays bounded.
 */
export const stageMeasureCap = 240;

const counts = new Map<string, number>();

function measureName(stage: TimedStage): string {
  return stage === "render-submit"
    ? "atlas:render-submit"
    : `atlas:paint:${stage}`;
}

/**
 * Runs `work` and, in a developer session, records its duration as the
 * stage's measure. A reader's session records nothing.
 */
export function timeStage<T>(
  developer: boolean,
  stage: TimedStage,
  work: () => T
): T {
  if (!developer) {
    return work();
  }
  const start = performance.now();
  try {
    return work();
  } finally {
    const name = measureName(stage);
    const kept = counts.get(name) ?? 0;
    if (kept >= stageMeasureCap) {
      performance.clearMeasures(name);
    }
    counts.set(name, kept >= stageMeasureCap ? 1 : kept + 1);
    performance.measure(name, { end: performance.now(), start });
  }
}
