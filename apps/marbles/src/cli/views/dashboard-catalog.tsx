import { DefinitionsBlock, TriggersBlock } from "~/components/blocks/catalog";
import { CatalogPanels } from "~/components/blocks/catalog-panels";
import type { CatalogModel } from "../state/dashboard-views";

const COMPACT_DEFINITIONS_BELOW = 75;

export function DashboardCatalog({
  catalog,
  besideDetails,
  width,
}: {
  readonly catalog: CatalogModel;
  readonly besideDetails: boolean;
  readonly width: number;
}) {
  const { definitions, triggers } = catalog;
  return (
    <CatalogPanels
      catalog={
        <DefinitionsBlock
          active={definitions.active}
          compact={besideDetails || width < COMPACT_DEFINITIONS_BELOW}
          items={definitions.items}
          onReset={catalog.onReset}
          onSelect={catalog.onInspect}
          searching={definitions.searching}
          selectedId={catalog.selectedId}
          workspace={catalog.workspace}
        />
      }
      triggers={
        <TriggersBlock
          active={triggers.active}
          compact={besideDetails}
          items={triggers.items}
          onReset={catalog.onReset}
          onSelect={catalog.onInspect}
          searching={triggers.searching}
          selectedId={catalog.selectedId}
        />
      }
    />
  );
}
