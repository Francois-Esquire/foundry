import {
  type DashboardSelection,
  type DefinitionSnapshot,
  isSelected,
  selectionKey,
  type TriggerSnapshot,
  triggerSelection,
} from "~/cli/state/dashboard-model";
import { KindBadge } from "~/components/blocks/kind-badge";
import { StatusLabel } from "~/components/blocks/status-label";
import { Panel } from "~/components/ui/panel";
import { SelectableRow } from "~/components/ui/selectable-row";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";
import { EmptyState } from "./empty-state";

interface CatalogProps {
  readonly active: boolean;
  readonly compact?: boolean;
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
  compact,
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
          id={rowId(item)}
          key={selectionKey(triggerSelection(item))}
          onSelect={onSelect}
          selected={selected?.kind === "trigger" && isSelected(item, selected)}
          value={triggerSelection(item)}
        >
          <box flexDirection="row" flexGrow={1} gap={1} height={1} minWidth={0}>
            <KindBadge kind={item.kind} />
            <Text
              flexGrow={compact ? 1 : 0}
              minWidth={0}
              truncate
              wrapMode="none"
            >
              {item.name}
            </Text>
            <box flexShrink={0}>
              <StatusLabel item={item} />
            </box>
            {!compact && (
              <text
                fg={theme.colors.mutedForeground}
                flexGrow={1}
                minWidth={0}
                truncate
                wrapMode="none"
              >
                {item.next ? `Next: ${item.next}` : item.description}
              </text>
            )}
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
  workspace,
  compact,
}: CatalogProps & {
  readonly items: readonly DefinitionSnapshot[];
  readonly workspace: string;
}) {
  return (
    <Panel
      active={active}
      id="panel:definition"
      selectedId={selected && selectionKey(selected)}
      title={
        compact ? "2 Marbles" : `2 Marbles · workflows & steps in ${workspace}`
      }
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
          <Text minWidth={0} truncate wrapMode="none">
            {item.name}
          </Text>
          {!compact && item.origin && (
            <text
              fg={theme.colors.mutedForeground}
              minWidth={0}
              truncate
              wrapMode="none"
            >
              {item.origin.external ? "outside workspace" : item.origin.source}
            </text>
          )}
        </SelectableRow>
      ))}
    </Panel>
  );
}

function rowId(item: TriggerSnapshot): string {
  return item.workspace === undefined
    ? `trigger:${item.id}`
    : `trigger:${selectionKey(triggerSelection(item))}`;
}
