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
