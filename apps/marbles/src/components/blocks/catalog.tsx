import type { BoxRenderable } from "@opentui/core";
import { useCallback, useState } from "react";
import { KindBadge } from "~/components/blocks/kind-badge";
import { StatusLabel, type StatusView } from "~/components/blocks/status-label";
import { Panel } from "~/components/ui/panel";
import { SelectableRow } from "~/components/ui/selectable-row";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";
import type { ItemKind } from "~/model/dashboard";
import { EmptyState } from "./empty-state";

interface CatalogRow<S> {
  readonly id: string;
  readonly key: string;
  readonly kind: ItemKind;
  readonly name: string;
  readonly selected: boolean;
  readonly selection: S;
}

export interface TriggerRow<S> extends CatalogRow<S> {
  readonly detail: string;
  readonly status: StatusView;
}

export interface DefinitionRow<S> extends CatalogRow<S> {
  readonly origin?: string;
}

interface CatalogProps<S> {
  readonly active: boolean;
  readonly compact?: boolean;
  readonly onReset?: () => void;
  readonly onSelect: (selection: S) => void;
  readonly searching?: boolean;
  readonly selectedId?: string;
}

const MARKER = 2;

function badgeWidth(kind: ItemKind): number {
  return kind.length + 3;
}

function statusWidth({ label, tone }: StatusView): number {
  return tone === "error" || tone === "warning"
    ? label.length + 2
    : label.length;
}

const KEPT = 12;

function shares(
  available: number,
  first: number,
  second: number
): readonly [number, number] | undefined {
  if (available <= 0 || first + second <= available) {
    return;
  }
  const room = Math.max(available - Math.min(second, KEPT), KEPT);
  const firstWidth = Math.min(first, room, available);
  return [firstWidth, available - firstWidth];
}

function useListWidth() {
  const [width, setWidth] = useState(0);
  const measure = useCallback(function measureList(this: BoxRenderable) {
    setWidth(this.width);
  }, []);
  return [width, measure] as const;
}

export function TriggersBlock<S>({
  items,
  selectedId,
  active,
  onSelect,
  searching,
  onReset,
  compact,
}: CatalogProps<S> & {
  readonly items: readonly TriggerRow<S>[];
}) {
  const [width, measure] = useListWidth();
  return (
    <Panel
      active={active}
      id="panel:trigger"
      selectedId={selectedId}
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
      {items.length > 0 && (
        <box flexDirection="column" flexShrink={0} onSizeChange={measure}>
          {items.map((item) => {
            const split = compact
              ? undefined
              : shares(
                  width -
                    MARKER -
                    badgeWidth(item.kind) -
                    statusWidth(item.status) -
                    2,
                  item.name.length,
                  item.detail.length
                );
            return (
              <SelectableRow
                id={item.id}
                key={item.key}
                onSelect={onSelect}
                selected={item.selected}
                value={item.selection}
              >
                <box
                  flexDirection="row"
                  flexGrow={1}
                  gap={1}
                  height={1}
                  minWidth={0}
                >
                  <KindBadge kind={item.kind} />
                  <Text
                    flexGrow={compact ? 1 : 0}
                    flexShrink={split ? 0 : 1}
                    minWidth={0}
                    truncate
                    width={split?.[0] ?? "auto"}
                    wrapMode="none"
                  >
                    {item.name}
                  </Text>
                  <box flexShrink={0}>
                    <StatusLabel status={item.status} />
                  </box>
                  {!compact && (
                    <text
                      fg={theme.colors.mutedForeground}
                      flexGrow={1}
                      flexShrink={split ? 0 : 1}
                      minWidth={0}
                      truncate
                      width={split?.[1] ?? "auto"}
                      wrapMode="none"
                    >
                      {item.detail}
                    </text>
                  )}
                </box>
              </SelectableRow>
            );
          })}
        </box>
      )}
    </Panel>
  );
}

export function DefinitionsBlock<S>({
  items,
  selectedId,
  active,
  onSelect,
  searching,
  onReset,
  workspace,
  compact,
}: CatalogProps<S> & {
  readonly items: readonly DefinitionRow<S>[];
  readonly workspace: string;
}) {
  const [width, measure] = useListWidth();
  return (
    <Panel
      active={active}
      id="panel:definition"
      selectedId={selectedId}
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
      {items.length > 0 && (
        <box flexDirection="column" flexShrink={0} onSizeChange={measure}>
          {items.map((item) => {
            const origin = compact ? undefined : item.origin;
            const split =
              origin === undefined
                ? undefined
                : shares(
                    width - MARKER - badgeWidth(item.kind) - 1,
                    item.name.length,
                    origin.length
                  );
            return (
              <SelectableRow
                id={item.id}
                key={item.key}
                onSelect={onSelect}
                selected={item.selected}
                value={item.selection}
              >
                <KindBadge kind={item.kind} />
                <Text
                  flexShrink={split ? 0 : 1}
                  minWidth={0}
                  truncate
                  width={split?.[0] ?? "auto"}
                  wrapMode="none"
                >
                  {item.name}
                </Text>
                {origin !== undefined && (
                  <text
                    fg={theme.colors.mutedForeground}
                    flexShrink={split ? 0 : 1}
                    minWidth={0}
                    truncate
                    width={split?.[1] ?? "auto"}
                    wrapMode="none"
                  >
                    {origin}
                  </text>
                )}
              </SelectableRow>
            );
          })}
        </box>
      )}
    </Panel>
  );
}
