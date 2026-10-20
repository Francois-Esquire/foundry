import { expect, it } from "vitest";
import { sampleGrid } from "../../src/lib/visualization/geology";
import {
  defaultRingWaveSettings,
  type RingWave,
  ringWaveEnvelope,
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

it("collapses a wave as it reaches the inner ring: length, width and opacity fall to nothing", () => {
  const { collapse } = defaultRingWaveSettings;
  expect(ringWaveEnvelope(0).opacity).toBe(0);
  expect(ringWaveEnvelope(collapse.rise)).toEqual({
    length: 1,
    opacity: 1,
    width: 1,
  });
  expect(ringWaveEnvelope(1)).toEqual({ length: 0, opacity: 0, width: 0 });
  const late = ringWaveEnvelope(0.99);
  expect(late.length).toBeLessThan(0.01);
  expect(late.opacity).toBeLessThan(0.01);
  let previous = ringWaveEnvelope(collapse.from);
  for (let phase = collapse.from + 0.05; phase < 1; phase += 0.05) {
    const next = ringWaveEnvelope(phase);
    expect(next.length).toBeLessThan(previous.length);
    expect(next.width).toBeLessThan(previous.width);
    expect(next.opacity).toBeLessThan(previous.opacity);
    previous = next;
  }
  // Resting, the wave is gone.
  expect(ringWaveEnvelope(1.3).opacity).toBe(0);
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
  // A crossing takes `crossing` seconds at the wave's tempo.
  const at = (time: number) => ringWavePhase(time, wave);
  const t0 = ((1 - wave.offset) * period) % period;
  expect(at(t0 + 1e-6)).toBeCloseTo(0, 4);
  expect(at(t0 + motion.crossing / wave.tempo / 2)).toBeCloseTo(0.5, 4);
});
