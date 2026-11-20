import { DefinitionsBlock, TriggersBlock } from "~/components/blocks/catalog";
import { CatalogPanels } from "~/components/blocks/catalog-panels";
import { selectionKey } from "../state/dashboard-model";
import { definitionRows, triggerRows } from "../state/dashboard-rows";
import type { Pane } from "../state/dashboard-state";
import type { Dashboard } from "../state/use-dashboard";

const COMPACT_DEFINITIONS_BELOW = 75;

export function DashboardCatalog({
  dashboard,
  activePane,
  besideDetails,
  width,
}: {
  readonly dashboard: Pick<
    Dashboard,
    | "clearFilters"
    | "definitions"
    | "inspect"
    | "snapshot"
    | "state"
    | "triggers"
  >;
  readonly activePane?: Pane;
  readonly besideDetails: boolean;
  readonly width: number;
}) {
  const { snapshot, state } = dashboard;
  const selectedId = state.selected && selectionKey(state.selected);
  return (
    <CatalogPanels
      catalog={
        <DefinitionsBlock
          active={activePane === "definition"}
          compact={besideDetails || width < COMPACT_DEFINITIONS_BELOW}
          items={definitionRows(dashboard.definitions, state.selected)}
          onReset={dashboard.clearFilters}
          onSelect={dashboard.inspect}
          searching={state.queries.definition.length > 0}
          selectedId={selectedId}
          workspace={snapshot.workspace}
        />
      }
      triggers={
        <TriggersBlock
          active={activePane === "trigger"}
          compact={besideDetails}
          items={triggerRows(dashboard.triggers, state.selected)}
          onReset={dashboard.clearFilters}
          onSelect={dashboard.inspect}
          searching={state.queries.trigger.length > 0}
          selectedId={selectedId}
        />
      }
    />
  );
}
