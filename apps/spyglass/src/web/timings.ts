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

export function releaseFirstFrame(): void {
  framed = true;
  for (const resolve of frameWaiters.splice(0)) {
    resolve();
  }
}

export function afterFirstFrame(): Promise<void> {
  return framed
    ? Promise.resolve()
    : new Promise((resolve) => {
        frameWaiters.push(resolve);
      });
}

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

export type PaintStage = `layer:${string}`;

export type TimedStage = PaintStage | "render-submit";

export const stageMeasureCap = 240;

const counts = new Map<string, number>();

function measureName(stage: TimedStage): string {
  return stage === "render-submit"
    ? "spyglass:render-submit"
    : `spyglass:paint:${stage}`;
}

export function recordStage(
  developer: boolean,
  stage: TimedStage,
  ms: number
): void {
  if (!developer) {
    return;
  }
  const name = measureName(stage);
  const kept = counts.get(name) ?? 0;
  if (kept >= stageMeasureCap) {
    performance.clearMeasures(name);
  }
  counts.set(name, kept >= stageMeasureCap ? 1 : kept + 1);
  const end = performance.now();
  performance.measure(name, { end, start: end - ms });
}

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
    recordStage(developer, stage, performance.now() - start);
  }
}
