import type { BoxRenderable } from "@opentui/core";
import { type ReactNode, useCallback, useState } from "react";

const MIN_PANEL_HEIGHT = 3;
const ROW_COUNT = 2;
const TOTAL_WEIGHT = 5;
/** Triggers' share of the Catalog tab; Marbles, usually the longer list, gets the rest. */
const TRIGGER_WEIGHT = 2;

/** The Catalog tab: Triggers above the larger Marbles list. */
export function CatalogPanels({
  triggers,
  catalog,
}: {
  readonly triggers: ReactNode;
  readonly catalog: ReactNode;
}) {
  const [sectionHeight, setSectionHeight] = useState(MIN_PANEL_HEIGHT);
  const measure = useCallback(function measurePanels(this: BoxRenderable) {
    const remaining = Math.max(0, this.height - ROW_COUNT * MIN_PANEL_HEIGHT);
    setSectionHeight(
      MIN_PANEL_HEIGHT + Math.floor((remaining * TRIGGER_WEIGHT) / TOTAL_WEIGHT)
    );
  }, []);
  return (
    <box
      flexDirection="column"
      flexGrow={1}
      minHeight={0}
      onSizeChange={measure}
    >
      <box flexDirection="column" flexShrink={0} height={sectionHeight}>
        {triggers}
      </box>
      <box flexDirection="column" flexGrow={1} minHeight={MIN_PANEL_HEIGHT}>
        {catalog}
      </box>
    </box>
  );
}
