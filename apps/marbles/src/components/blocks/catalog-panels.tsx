import type { BoxRenderable } from "@opentui/core";
import { type ReactNode, useCallback } from "react";

const MIN_PANEL_HEIGHT = 3;
const TWO_ROW_PANEL_HEIGHT = 4;
const PANEL_COUNT = 2;
const TOTAL_WEIGHT = 5;
const TRIGGER_WEIGHT = 2;

function triggerHeight(height: number): number {
  const spare = Math.max(0, height - PANEL_COUNT * MIN_PANEL_HEIGHT);
  const shared =
    MIN_PANEL_HEIGHT + Math.floor((spare * TRIGGER_WEIGHT) / TOTAL_WEIGHT);
  const twoRows = height >= PANEL_COUNT * TWO_ROW_PANEL_HEIGHT;
  return twoRows ? Math.max(TWO_ROW_PANEL_HEIGHT, shared) : shared;
}

export function CatalogPanels({
  triggers,
  catalog,
}: {
  readonly triggers: ReactNode;
  readonly catalog: ReactNode;
}) {
  const measure = useCallback(function measurePanels(this: BoxRenderable) {
    const [section] = this.getChildren();
    if (section) {
      section.height = triggerHeight(this.height);
    }
  }, []);
  return (
    <box
      flexDirection="column"
      flexGrow={1}
      minHeight={0}
      onSizeChange={measure}
    >
      <box flexDirection="column" flexShrink={0} height={MIN_PANEL_HEIGHT}>
        {triggers}
      </box>
      <box flexDirection="column" flexGrow={1} minHeight={MIN_PANEL_HEIGHT}>
        {catalog}
      </box>
    </box>
  );
}
