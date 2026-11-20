import type { ReactNode } from "react";

const MIN_PANEL_HEIGHT = 3;
const TRIGGER_WEIGHT = 2;
const CATALOG_WEIGHT = 3;

export function CatalogPanels({
  triggers,
  catalog,
}: {
  readonly triggers: ReactNode;
  readonly catalog: ReactNode;
}) {
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <box
        flexBasis={MIN_PANEL_HEIGHT}
        flexDirection="column"
        flexGrow={TRIGGER_WEIGHT}
        flexShrink={0}
        minHeight={MIN_PANEL_HEIGHT}
      >
        {triggers}
      </box>
      <box
        flexBasis={MIN_PANEL_HEIGHT}
        flexDirection="column"
        flexGrow={CATALOG_WEIGHT}
        flexShrink={0}
        minHeight={MIN_PANEL_HEIGHT}
      >
        {catalog}
      </box>
    </box>
  );
}
