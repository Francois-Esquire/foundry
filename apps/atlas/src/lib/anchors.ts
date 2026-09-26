import type { Boundary } from "./boundary";
import type { AnalysisConfig, AnchorDefinition } from "./config";
import type { ReductionOperation } from "./types";

/**
 * What an anchor protects, per operation. An anchor preserves the package
 * boundary itself: operations that would remove the boundary are blocked;
 * operations that only narrow the public surface remain allowed.
 */
const REMOVES_PACKAGE_BOUNDARY: Record<ReductionOperation, boolean> = {
  "fold-package": true,
  "internalize-symbol": false,
  "preserve-shared-boundary": false,
};

/** The anchor matching this boundary (by package name or path), if any. */
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
