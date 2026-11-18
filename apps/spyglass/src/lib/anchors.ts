import type { Boundary } from "./boundary";
import type { AnalysisConfig, AnchorDefinition } from "./config";
import type { ReductionOperation } from "./types";

const REMOVES_PACKAGE_BOUNDARY: Record<ReductionOperation, boolean> = {
  "fold-package": true,
  "internalize-symbol": false,
  "preserve-shared-boundary": false,
};

export function anchorFor(
  boundary: Boundary,
  config: AnalysisConfig
): AnchorDefinition | undefined {
  return config.anchors.find(
    (anchor) =>
      anchor.target === boundary.packageName ||
      anchor.target === boundary.relPath
  );
}

export function anchorBlocks(operation: ReductionOperation): boolean {
  return REMOVES_PACKAGE_BOUNDARY[operation];
}
