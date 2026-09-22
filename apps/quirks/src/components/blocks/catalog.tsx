import { KindBadge } from "~/components/kind-badge";
import { Panel } from "~/components/panel";
import { SelectableRow } from "~/components/selectable-row";
import { StatusLabel } from "~/components/status-label";
import { Text } from "~/components/ui/text";
import { useTheme } from "~/hooks/use-theme";
import {
  type DashboardSelection,
  type DefinitionSnapshot,
  selectionKey,
  type TriggerSnapshot,
} from "~/views/dashboard-model";

interface CatalogProps {
  readonly active: boolean;
  readonly onSelect: (selection: DashboardSelection) => void;
  readonly searching?: boolean;
  readonly selected?: DashboardSelection;
}

export function TriggersBlock({
  items,
  selected,
  active,
  onSelect,
  searching,
}: CatalogProps & {
  readonly items: readonly TriggerSnapshot[];
}) {
  const theme = useTheme();
  return (
    <Panel
      active={active}
      id="panel:trigger"
      selectedId={selected && selectionKey(selected)}
      title="1 Triggers"
    >
      {items.length === 0 && (
        <Text>
          {searching ? "No matching triggers." : "No schedules or monitors."}
        </Text>
      )}
      {items.map((item) => (
        <SelectableRow
          id={`trigger:${item.id}`}
          key={item.id}
          onSelect={onSelect}
          selected={selected?.kind === "trigger" && selected.id === item.id}
          value={{ id: item.id, kind: "trigger" }}
        >
          <box flexDirection="row" flexGrow={1} gap={1} height={1} minWidth={0}>
            <KindBadge kind={item.kind} />
            <Text wrapMode="none">{item.name}</Text>
            <box flexShrink={0}>
              <StatusLabel status={item.status} />
            </box>
            <text
              fg={theme.colors.mutedForeground}
              flexGrow={1}
              minWidth={0}
              wrapMode="none"
            >
              {item.next ? `Next: ${item.next}` : item.description}
            </text>
          </box>
        </SelectableRow>
      ))}
    </Panel>
  );
}

export function DefinitionsBlock({
  items,
  selected,
  active,
  onSelect,
  searching,
}: CatalogProps & { readonly items: readonly DefinitionSnapshot[] }) {
  return (
    <Panel
      active={active}
      id="panel:definition"
      selectedId={selected && selectionKey(selected)}
      title="2 Catalog · workflows & steps"
    >
      {items.length === 0 && (
        <Text>
          {searching
            ? "No matching workflows or steps."
            : "No workflows or steps."}
        </Text>
      )}
      {items.map((item) => (
        <SelectableRow
          id={`definition:${item.id}`}
          key={item.id}
          onSelect={onSelect}
          selected={selected?.kind === "definition" && selected.id === item.id}
          value={{ id: item.id, kind: "definition" }}
        >
          <KindBadge kind={item.kind} />
          <Text>{item.name}</Text>
        </SelectableRow>
      ))}
    </Panel>
  );
}
