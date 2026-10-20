import type { SpyglassData, Territory } from "../data/types";
import type { BelongingLayer } from "../layout/belonging";
import type { DomainRef } from "../layout/domain-extent";
import type { ResponsibilityOverlay } from "../layout/responsibility-focus";
import type { ChartSettings } from "../settings/chart-settings";

/** The part of the viewer's state the scene draws: one snapshot, applied whole. */
export interface AppliedState {
  belongingLayer: BelongingLayer | null;
  chartSettings: ChartSettings;
  /** The spyglass with its late readings; the geometry the scene was built from never changes. */
  data: SpyglassData;
  /**
   * The declared domain drawn across the islands, chosen in Find. Not a
   * selection: it stays while islands, districts and files are selected.
   */
  domain: DomainRef | null;
  /** The legend's height in CSS pixels, which the latitude scale stops short of. */
  legendHeight: number;
  responsibility: ResponsibilityOverlay | null;
  showConnections: boolean;
  territoryLayout: Territory | null;
}

/** A field of the applied state whose value changed, named for the work it asks of the scene. */
export type Change = keyof AppliedState;

/**
 * The order the scene does the work in: rendering settings first, then the
 * data every later step reads, the belonging layer, the territory relayout
 * (which refocuses the camera), and the flags that only repaint.
 */
const order: readonly Change[] = [
  "chartSettings",
  "data",
  "belongingLayer",
  "territoryLayout",
  "showConnections",
  "domain",
  "legendHeight",
  "responsibility",
];

/**
 * The fields of `next` the scene must act on: every field on the first
 * apply, and afterwards each whose value is not the one applied before, by
 * identity. A snapshot that changed only elsewhere plans no work.
 */
export function planApply(
  previous: AppliedState | null,
  next: AppliedState
): Change[] {
  return order.filter(
    (field) => previous === null || previous[field] !== next[field]
  );
}
