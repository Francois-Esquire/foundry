/** Shared spectrum for the CPU buoyancy sampler and water/waves.wgsl. */
export type Wave = readonly [number, number, number, number];

export const WAVE_PHASE = 2.399_963;
const WAVELENGTHS = [3.8, 2.4, 1.65, 1.1, 0.78, 0.52, 0.34, 0.23];
const AMPLITUDES = [0.065, 0.038, 0.022, 0.013, 0.006, 0.003, 0.0014, 0.0006];

/** kx, kz, angular frequency, amplitude. One scene unit is about a toy hull length. */
export const WATER_WAVES: readonly Wave[] = WAVELENGTHS.map((length, i) => {
  const k = (2 * Math.PI) / length;
  const angle = 0.45 + i * WAVE_PHASE;
  return [
    Math.cos(angle) * k,
    Math.sin(angle) * k,
    Math.sqrt(1.1 * k),
    // The two lists run side by side, so every wavelength has its amplitude.
    AMPLITUDES[i] ?? 0,
  ];
});

export interface WaterSample {
  height: number;
  slopeX: number;
  slopeZ: number;
  velocity: number;
}

export function sampleWater(
  x: number,
  z: number,
  time: number,
  strength: number
): WaterSample {
  let height = 0;
  let slopeX = 0;
  let slopeZ = 0;
  let velocity = 0;
  for (const [i, wave] of WATER_WAVES.entries()) {
    const [kx, kz, frequency, amplitude] = wave;
    const phase = kx * x + kz * z - frequency * time + i * WAVE_PHASE;
    const a = amplitude * strength;
    const derivative = a * Math.cos(phase);
    height += a * Math.sin(phase);
    slopeX += derivative * kx;
    slopeZ += derivative * kz;
    velocity -= derivative * frequency;
  }
  return { height, slopeX, slopeZ, velocity };
}
