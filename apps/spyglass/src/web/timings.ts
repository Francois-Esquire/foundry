/**
 * The viewer's load, and the stages of each map repaint, as Performance API
 * entries: DevTools shows them as user timings, and `scripts/capture.ts`
 * reads them with its `marks` step.
 */

/**
 * Named points in the load, in the order they happen; the last,
 * `spyglass:readings-loaded`, when the readings read after the layout
 * (`loadLateReadings`) have arrived, falls wherever their read ends, most
 * often during the terrain build.
 */
export const loadMarks = [
  "spyglass:data-requested",
  "spyglass:data-loaded",
  "spyglass:layout-settled",
  "spyglass:terrain-built",
  "spyglass:first-frame",
  "spyglass:readings-loaded",
] as const;

export type LoadMark = (typeof loadMarks)[number];

const recorded = new Set<LoadMark>();

let framed = false;
const frameWaiters: (() => void)[] = [];

/**
 * Lets work wait for the first frame: everything waiting resolves, and
 * `afterFirstFrame` resolves at once from then on. Called when the first
 * frame is submitted, and by the map when it cannot open, so nothing waits
 * for a frame that never comes.
 */
export function releaseFirstFrame(): void {
  framed = true;
  for (const resolve of frameWaiters.splice(0)) {
    resolve();
  }
}

/** Resolves once the first frame is submitted (or the map has failed to open), for work that must not delay it. */
export function afterFirstFrame(): Promise<void> {
  return framed
    ? Promise.resolve()
    : new Promise((resolve) => {
        frameWaiters.push(resolve);
      });
}

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
  if (mark === "spyglass:first-frame") {
    releaseFirstFrame();
  }
}

/**
 * The stages of one map repaint, each measured as `spyglass:paint:<stage>`:
 * each scene layer's update (`layer:<id>`, the list in `scene/scene.ts`,
 * which includes every mark layer of `scene/marks/layers.ts` and the labels
 * layer, `layer:labels`, whose update proposes, places and letters the
 * chart's text as elements). The same durations, for the latest frame only,
 * are on the composition the scene's `describe` reports, which is measured
 * in every session; the pass graph's stages have no measure of their own,
 * since the GPU times the frame as a whole (`RenderStatus.frameMs`).
 */
export type PaintStage = `layer:${string}`;

/**
 * What a developer session times: each repaint's stages, and
 * `render-submit`, measured as `spyglass:render-submit`: the CPU time to encode
 * and submit one frame, for every frame submitted, whether a repaint asked
 * for it or not, so a count of these over an idle window tells whether the
 * scene is drawing unasked (it should not, unless a layer animates). GPU
 * time is not measured. Work the scene does off the frame, such as the
 * belonging layer's preparation in idle time, is not a stage and is not timed.
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
    ? "spyglass:render-submit"
    : `spyglass:paint:${stage}`;
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
