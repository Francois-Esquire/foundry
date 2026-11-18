export type Wave = readonly [number, number, number, number];

const DIRECTION_STEP = 2.399_963;
const WAVELENGTHS = [3.8, 2.4, 1.65, 1.1, 0.78, 0.52, 0.34, 0.23];
const AMPLITUDES = [0.065, 0.038, 0.022, 0.013, 0.006, 0.003, 0.0014, 0.0006];

export const WATER_WAVES: readonly Wave[] = WAVELENGTHS.map((length, i) => {
  const k = (2 * Math.PI) / length;
  const angle = 0.45 + i * DIRECTION_STEP;
  return [
    Math.cos(angle) * k,
    Math.sin(angle) * k,
    Math.sqrt(1.1 * k),
    AMPLITUDES[i] ?? 0,
  ];
});
