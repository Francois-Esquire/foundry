export type SettlementTier = "village" | "town" | "city";

export function footprint(size: number) {
  return 28 + 5.8 * Math.sqrt(size);
}

export function latitude(layer: number) {
  return -220 * layer;
}

export function attraction(strength: number) {
  return Math.log2(2 + strength);
}

export function settlementTier(size: number): SettlementTier {
  if (size >= 300) {
    return "city";
  }
  return size >= 40 ? "town" : "village";
}

export function territoryLabelSize(radius: number) {
  return Math.max(13, Math.min(22, radius * 0.15));
}

export function labelPriority(dependents: number, dependencies: number) {
  return dependents + dependencies;
}

export function neighborhoodAffinity(imports: number, conceptAffinity: number) {
  return imports + 0.5 * Math.min(1, conceptAffinity);
}

export function laneWidth(strength: number, strongest: number) {
  return 0.35 + (0.25 * Math.log1p(strength)) / Math.log1p(strongest);
}

export function roadWidth(strength: number, strongest: number) {
  return 0.7 + Math.log1p(strength) / Math.log1p(strongest);
}

export function currentStrength(imports: number) {
  return Math.log1p(imports);
}

export function districtAffinity(moduleEdges: number, symbolFlow: number) {
  return Math.log1p(moduleEdges) + Math.log1p(symbolFlow);
}

/** Landmark footprint for a structurally significant module, from the modules that draw on it. */
export function landmarkRadius(dependents: number) {
  return Math.min(6, 2 + 0.8 * Math.sqrt(dependents));
}

/** Stream width between two districts, from their module edges. */
export function streamWidth(moduleEdges: number, strongest: number) {
  return 0.35 + (0.75 * Math.log1p(moduleEdges)) / Math.log1p(strongest);
}

/** Crowd and zoom control cartographic texture, never the unresolved count itself. */
export function marshDetail(unresolved: number, pixels: number) {
  return {
    opacity: Math.max(
      0.35,
      Math.min(1, Math.sqrt(12 / Math.max(1, unresolved)))
    ),
    spacing: Math.max(2.4, 10 / pixels),
  };
}

/** A shared river keeps a mineral body, then resolves to a fine pen line. */
export function riverPen(width: number, pixels: number) {
  return Math.min(width, (0.65 + 1.6 * width) / pixels);
}

/** Engraving follows density slope; zoom limits its contrast beneath file ink. */
export function reliefHachure(slope: number, pixels = 1) {
  if (slope <= 0.24) {
    return { length: 0, opacity: 0 };
  }
  return {
    length: Math.min(3.6, 0.8 + slope * 3),
    opacity:
      Math.min(0.22, slope * 0.25) * Math.min(1, Math.max(0, pixels - 1.2)),
  };
}

/** File settlements remain legible as the camera enters close detail. */
export function filePen(pixels: number) {
  return Math.min(1.8, 4.5 / pixels);
}

/** Fixed chart coordinates; reveal fifths only when their spacing has room. */
export function chartGrid(pixels: number) {
  return {
    majorStep: 90,
    minorOpacity: 0.14 * Math.max(0, Math.min(1, (18 * pixels - 30) / 30)),
    minorStep: 18,
  };
}

/** Prominence is dependency reach within this package, never a quality score. */
export function prominentFile(dependents: number, percentile: number) {
  return dependents >= 5 && percentile >= 0.95;
}

/** Recorded commits, ranked against repository files of the same kind/window. */
export function changeCrater(commits: number, percentile: number) {
  return commits >= 3 && percentile >= 0.8;
}

/** Broad concentration supplies the foothills; local concentration resolves crests. */
export function concentrationRelief(broad: number, local: number) {
  return 6 * (1 - Math.exp(-broad / 40)) + 12 * (1 - Math.exp(-local / 5));
}

/** Evidence kernels at two spatial scales; neither introduces decorative noise. */
export function concentrationSample(squaredDistance: number) {
  const reach = Math.max(0, 1 - Math.sqrt(squaredDistance) / 16);
  return {
    broad: Math.exp(-squaredDistance / (2 * 22 ** 2)),
    local: reach * reach,
  };
}
