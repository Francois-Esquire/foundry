import { defaultBoundaries } from "./boundaries";
import { defaultLandmassSettings } from "./landmasses";

export const chartFilters = {
  faded: { filter: "saturate(0.45) sepia(0.18)", label: "Faded pigments" },
  graphite: { filter: "grayscale(1)", label: "Graphite" },
  original: { filter: "none", label: "Original" },
  treasure: {
    filter: "grayscale(1) sepia(0.65) saturate(0.85)",
    label: "Treasure parchment",
  },
};

export const defaultChartSettings = {
  ...defaultLandmassSettings,
  boundaries: defaultBoundaries,
  contours: false,
  currentSpeed: 1,
  dependencyInfluence: 1,
  filter: "original" as keyof typeof chartFilters,
  layers: {
    forests: false,
    houses: false,
    land: false,
    roads: false,
    trade: false,
  },
  waterColor: "#d5dbca",
  waterContrast: 0.3,
  waveAmount: 0.45,
  wavelength: 36,
  waveStrength: 0.45,
  windDirection: 45,
  windInfluence: 0.3,
  windStrength: 0.5,
};

export type ChartSettings = typeof defaultChartSettings;
