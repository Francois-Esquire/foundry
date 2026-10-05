import type { BoxRenderable } from "@opentui/core";
import { type ReactNode, useCallback, useState } from "react";

const MIN_PANEL_HEIGHT = 3;
const ROW_COUNT = 3;
const TOTAL_WEIGHT = 5;

/** Triggers and Marbles get equal space; Runs gets the larger remaining area. */
export function ExecutionPanels({
  triggers,
  catalog,
  runs,
}: {
  readonly triggers: ReactNode;
  readonly catalog: ReactNode;
  readonly runs: ReactNode;
}) {
  const [sectionHeight, setSectionHeight] = useState(MIN_PANEL_HEIGHT);
  const measure = useCallback(function measurePanels(this: BoxRenderable) {
    const remaining = Math.max(0, this.height - ROW_COUNT * MIN_PANEL_HEIGHT);
    setSectionHeight(MIN_PANEL_HEIGHT + Math.floor(remaining / TOTAL_WEIGHT));
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
      <box flexDirection="column" flexShrink={0} height={sectionHeight}>
        {catalog}
      </box>
      <box flexDirection="column" flexGrow={1} minHeight={MIN_PANEL_HEIGHT}>
        {runs}
      </box>
    </box>
  );
}
