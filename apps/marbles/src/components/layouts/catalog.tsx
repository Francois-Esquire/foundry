import type { ReactNode } from "react";

export function CatalogLayout({
  catalog,
  details,
}: {
  readonly catalog: ReactNode;
  readonly details?: ReactNode;
}) {
  if (details === undefined) {
    return catalog;
  }
  return (
    <box flexDirection="row" flexGrow={1} gap={1} minHeight={0}>
      <box flexBasis={0} flexDirection="column" flexGrow={2} minWidth={0}>
        {catalog}
      </box>
      <box flexBasis={0} flexDirection="column" flexGrow={3} minWidth={0}>
        {details}
      </box>
    </box>
  );
}
