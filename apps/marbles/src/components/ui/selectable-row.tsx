import { type ReactNode, useCallback } from "react";
import { theme } from "~/components/ui/theme";
import { Text } from "./text";

export function SelectableRow<T>({
  id,
  selected,
  onSelect,
  value,
  children,
  depth = 0,
}: {
  readonly id: string;
  readonly selected: boolean;
  readonly onSelect: (value: T) => void;
  readonly value: T;
  readonly children: ReactNode;
  readonly depth?: number;
}) {
  const handleSelect = useCallback(() => onSelect(value), [onSelect, value]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI boxes are terminal controls; DashboardView provides keyboard navigation.
    <box
      backgroundColor={selected ? theme.colors.muted : undefined}
      flexDirection="row"
      flexShrink={0}
      gap={1}
      id={id}
      onMouseDown={handleSelect}
      paddingLeft={depth * 2}
    >
      <Text flexShrink={0}>{selected ? "›" : " "}</Text>
      {children}
    </box>
  );
}
