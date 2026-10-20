import { expect, it } from "vitest";
import { sampleGrid } from "../../src/lib/visualization/geology";
import {
  defaultRingWaveSettings,
  type RingWave,
  ringWaveBow,
  ringWaveLife,
  ringWaveLocalPhase,
  ringWavePhase,
  ringWaves,
} from "../../src/lib/visualization/ring-waves";
import { chartHull } from "../../src/web/layout/chart-hull";
import { chartSeaBounds } from "../../src/web/view/chart-view";
import { loadSpyglass } from "../helpers/reference-spyglass";

async function fixtureHull() {
  const data = await loadSpyglass();
  return chartHull(data, chartSeaBounds(data));
}

const lerp = (
  a: readonly [number, number],
  b: readonly [number, number],
  t: number
): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

it("chooses the same waves for the same field and seed, and others for another seed", async () => {
  const hull = await fixtureHull();
  const waves = ringWaves(hull.field, hull.rings());
  expect(waves.length).toBeGreaterThan(50);
  expect(ringWaves(hull.field, hull.rings())).toEqual(waves);
  const reseeded = ringWaves(hull.field, hull.rings(), {
    ...defaultRingWaveSettings,
    seed: 7,
  });
  expect(reseeded.map(({ site }) => site)).not.toEqual(
    waves.map(({ site }) => site)
  );
});

it("starts waves only on the rings in range, spread round each ring and kept apart", async () => {
  const hull = await fixtureHull();
  const { rings, spacing } = defaultRingWaveSettings;
  const waves = ringWaves(hull.field, hull.rings());
  const byRing = new Map<number, RingWave[]>();
  for (const wave of waves) {
    expect(wave.ring).toBeGreaterThanOrEqual(rings.from);
    expect(wave.ring).toBeLessThanOrEqual(rings.to);
    byRing.set(wave.ring, [...(byRing.get(wave.ring) ?? []), wave]);
  }
  expect([...byRing.keys()].toSorted((a, b) => a - b)).toEqual(
    Array.from({ length: rings.to - rings.from + 1 }, (_, i) => rings.from + i)
  );
  const [cx, cy] = [
    hull.field.left + (hull.field.width * hull.field.cell) / 2,
    hull.field.top + (hull.field.height * hull.field.cell) / 2,
  ];
  for (const ringWavesOn of byRing.values()) {
    // Neighbouring sites keep at least the stretches' margins apart.
    for (const [i, a] of ringWavesOn.entries()) {
      for (const b of ringWavesOn.slice(i + 1)) {
        const apart = Math.hypot(a.site[0] - b.site[0], a.site[1] - b.site[1]);
        expect(apart).toBeGreaterThan(0.3 * spacing * a.gap);
      }
    }
    // Round the archipelago, not bunched on one side: most octants hold one.
    const octants = new Set(
      ringWavesOn.map(({ site }) =>
        Math.floor(
          ((Math.atan2(site[1] - cy, site[0] - cx) + Math.PI) / (2 * Math.PI)) *
            8
        )
      )
    );
    expect(octants.size).toBeGreaterThanOrEqual(5);
  }
});

it("starts each crest on its ring and carries it to the ring inside, on the open sea", async () => {
  const hull = await fixtureHull();
  const { field } = hull;
  for (const wave of ringWaves(field, hull.rings())) {
    expect(wave.start).toHaveLength(defaultRingWaveSettings.samples);
    expect(wave.end).toHaveLength(wave.start.length);
    for (const [j, start] of wave.start.entries()) {
      const end = wave.end[j] ?? start;
      expect(sampleGrid(field, field.ring, ...start)).toBeCloseTo(wave.ring, 1);
      expect(sampleGrid(field, field.ring, ...end)).toBeCloseTo(
        wave.ring - 1,
        1
      );
      // Never inside the hull, where the platform and the islands lie.
      expect(sampleGrid(field, field.distance, ...end)).toBeGreaterThanOrEqual(
        -field.cell
      );
    }
  }
});

it("moves every crest inward: its ring coordinate falls as its phase runs", async () => {
  const hull = await fixtureHull();
  const { field } = hull;
  const phases = [0, 0.25, 0.5, 0.75, 1];
  for (const wave of ringWaves(field, hull.rings())) {
    const middle = Math.floor(wave.start.length / 2);
    for (const j of [0, middle, wave.start.length - 1]) {
      const start = wave.start[j] ?? [0, 0];
      const end = wave.end[j] ?? start;
      const coordinates = phases.map((phase) =>
        sampleGrid(field, field.ring, ...lerp(start, end, phase))
      );
      for (let k = 1; k < coordinates.length; k += 1) {
        expect(coordinates[k]).toBeLessThan((coordinates[k - 1] ?? 0) + 1e-3);
      }
      expect(coordinates[0]).toBeGreaterThan((coordinates.at(-1) ?? 0) + 0.9);
    }
  }
});

/** The phases from 0 up to 1 in steps of `by`. */
const phaseSteps = (by = 0.005) =>
  Array.from({ length: Math.round(1 / by) }, (_, i) => i * by);

/** The phase in `phaseSteps()` where `channel` peaks. */
const peakOf = (channel: (phase: number) => number) =>
  phaseSteps().reduce((best, phase) =>
    channel(phase) > channel(best) ? phase : best
  );

it("builds a wave up steadily: its swell, bow and light only grow until it is built", () => {
  const { life } = defaultRingWaveSettings;
  let previous = ringWaveLife(0);
  for (const phase of phaseSteps().filter(
    (each) => each > 0 && each <= life.build
  )) {
    const next = ringWaveLife(phase);
    expect(next.build).toBeGreaterThanOrEqual(previous.build);
    expect(next.bow).toBeGreaterThanOrEqual(previous.bow);
    expect(next.glow).toBeGreaterThanOrEqual(previous.glow);
    expect(next.swell).toBeGreaterThanOrEqual(previous.swell);
    previous = next;
  }
  expect(ringWaveLife(life.build).build).toBe(1);
  expect(ringWaveLife(life.build).glow).toBe(1);
  // The bow, the spread and the pitch never fall back while the wave crosses.
  for (const phase of phaseSteps().slice(1)) {
    expect(ringWaveLife(phase).bow).toBeGreaterThanOrEqual(
      ringWaveLife(phase - 0.005).bow
    );
    expect(ringWaveLife(phase).spread).toBeGreaterThanOrEqual(
      ringWaveLife(phase - 0.005).spread
    );
    expect(ringWaveLife(phase).pitch).toBeGreaterThanOrEqual(
      ringWaveLife(phase - 0.005).pitch
    );
  }
});

it("lights the face before the lip folds, and folds before it crashes into foam", () => {
  const { life } = defaultRingWaveSettings;
  const glowPeak = peakOf((phase) => ringWaveLife(phase).glow);
  const lipPeak = peakOf((phase) => ringWaveLife(phase).lip);
  const foamPeak = peakOf((phase) => ringWaveLife(phase).foam);
  expect(glowPeak).toBeCloseTo(life.build, 2);
  expect(lipPeak).toBeCloseTo(life.fold, 2);
  expect(glowPeak).toBeLessThan(lipPeak);
  expect(lipPeak).toBeLessThan(foamPeak);
  // No lip before the wave is built, and the lip and the light are gone into foam at the crash.
  expect(ringWaveLife(life.build * 0.9).lip).toBe(0);
  expect(ringWaveLife(life.crash).lip).toBe(0);
  expect(ringWaveLife(life.crash).glow).toBe(0);
  expect(ringWaveLife(life.crash).foam).toBe(1);
  expect(ringWaveLife(life.fold).foam).toBe(0);
});

it("fades a wave to nothing on the inner ring, and draws nothing while it rests", () => {
  expect(ringWaveLife(0).opacity).toBe(0);
  const late = ringWaveLife(0.995);
  for (const value of Object.values(late)) {
    expect(value).toBeLessThan(1.01);
  }
  expect(late.opacity).toBeLessThan(0.01);
  expect(late.foam).toBeLessThan(0.01);
  for (const phase of [1, 1.2, 1.49, -0.1]) {
    expect(
      Object.values(ringWaveLife(phase)).every((value) => value === 0)
    ).toBe(true);
  }
  let previous = ringWaveLife(defaultRingWaveSettings.life.crash);
  for (const phase of phaseSteps().filter(
    (each) => each > defaultRingWaveSettings.life.crash
  )) {
    const next = ringWaveLife(phase);
    expect(next.opacity).toBeLessThan(previous.opacity);
    previous = next;
  }
});

it("bows the crest forward at its apex, its ends lagging, and peels the fold out from the apex", () => {
  expect(ringWaveBow(0)).toBe(1);
  expect(ringWaveBow(-1)).toBe(0);
  expect(ringWaveBow(1)).toBe(0);
  expect(ringWaveBow(1.5)).toBe(0);
  for (let along = 0.1; along <= 1; along += 0.1) {
    expect(ringWaveBow(along)).toBeLessThan(ringWaveBow(along - 0.1));
    expect(ringWaveBow(-along)).toBeCloseTo(ringWaveBow(along), 12);
  }
  const { life } = defaultRingWaveSettings;
  expect(ringWaveLocalPhase(0.6, 0)).toBe(0.6);
  expect(ringWaveLocalPhase(0.6, 1)).toBeCloseTo(0.6 - life.peel, 12);
  // When the apex folds, the ends are still building.
  const apex = ringWaveLife(ringWaveLocalPhase(life.fold, 0)).lip;
  const end = ringWaveLife(ringWaveLocalPhase(life.fold, 1)).lip;
  expect(apex).toBe(1);
  expect(end).toBeLessThan(apex);
});

it("staggers the waves and brings each round again after its rest", async () => {
  const hull = await fixtureHull();
  const { motion } = defaultRingWaveSettings;
  const waves = ringWaves(hull.field, hull.rings());
  const span = 1 + motion.rest;
  const phases = waves.map((each) => ringWavePhase(10, each));
  for (const phase of phases) {
    expect(phase).toBeGreaterThanOrEqual(0);
    expect(phase).toBeLessThan(span);
  }
  const crossing = phases.filter((phase) => phase < 1).length / phases.length;
  expect(crossing).toBeGreaterThan(0.4);
  expect(crossing).toBeLessThan(0.9);
  const [wave] = waves;
  if (!wave) {
    throw new Error("The fixture has waves");
  }
  const period = (motion.crossing * span) / wave.tempo;
  expect(ringWavePhase(3 + period, wave)).toBeCloseTo(
    ringWavePhase(3, wave),
    6
  );
  // Neighbours on one ring keep unrelated staggers and tempos, so they never pulse together.
  const pairs = waves.flatMap((each, i) => {
    const before = waves[i - 1];
    return before && before.ring === each.ring ? [[before, each] as const] : [];
  });
  const apart = (pick: (each: RingWave) => number) =>
    pairs.reduce((sum, [a, b]) => sum + Math.abs(pick(a) - pick(b)), 0) /
    pairs.length;
  expect(pairs.length).toBeGreaterThan(50);
  expect(apart(({ offset }) => offset)).toBeGreaterThan(0.25);
  expect(apart(({ tempo }) => tempo) / motion.variance).toBeGreaterThan(0.5);
  // A crossing takes `crossing` seconds at the wave's tempo.
  const at = (time: number) => ringWavePhase(time, wave);
  const t0 = ((1 - wave.offset) * period) % period;
  expect(at(t0 + 1e-6)).toBeCloseTo(0, 4);
  expect(at(t0 + motion.crossing / wave.tempo / 2)).toBeCloseTo(0.5, 4);
});
