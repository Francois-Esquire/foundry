import { KindBadge } from "~/components/blocks/kind-badge";
import { StatusLabel } from "~/components/blocks/status-label";
import { Panel } from "~/components/ui/panel";
import { SelectableRow } from "~/components/ui/selectable-row";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";
import {
  type DashboardSelection,
  type DefinitionSnapshot,
  selectionKey,
  type TriggerSnapshot,
} from "~/views/dashboard-model";
import { EmptyState } from "./empty-state";

interface CatalogProps {
  readonly active: boolean;
  readonly onReset?: () => void;
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
  onReset,
}: CatalogProps & {
  readonly items: readonly TriggerSnapshot[];
}) {
  return (
    <Panel
      active={active}
      id="panel:trigger"
      selectedId={selected && selectionKey(selected)}
      title="1 Triggers"
    >
      {items.length === 0 && (
        <EmptyState
          description={
            searching
              ? "Try another search or clear filters."
              : "Add schedule() or monitor() in .foundry/marbles when you want automatic runs."
          }
          onReset={searching ? onReset : undefined}
          title={
            searching ? "No matching triggers." : "No schedules or monitors."
          }
        />
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
              <StatusLabel item={item} />
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
  onReset,
}: CatalogProps & { readonly items: readonly DefinitionSnapshot[] }) {
  return (
    <Panel
      active={active}
      id="panel:definition"
      selectedId={selected && selectionKey(selected)}
      title="2 Marbles · workflows & steps"
    >
      {items.length === 0 && (
        <EmptyState
          description={
            searching
              ? "Try another search or clear filters."
              : "Choose a starter during setup, or add a prebuilt step in .foundry/marbles."
          }
          onReset={searching ? onReset : undefined}
          title={
            searching
              ? "No matching workflows or steps."
              : "No workflows or steps."
          }
        />
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
