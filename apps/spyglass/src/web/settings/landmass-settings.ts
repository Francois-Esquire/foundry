/** The layout's tuning: how far coasts stand off one another and how much open water each island keeps. */
export const defaultLandmassSettings = {
  coastalBuffer: 32,
  islandClearance: 45,
};
export type LandmassSettings = typeof defaultLandmassSettings;
