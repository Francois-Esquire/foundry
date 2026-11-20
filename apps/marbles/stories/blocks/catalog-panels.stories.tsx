import { defineStories, story } from "textbook-sh";
import { DefinitionsBlock, TriggersBlock } from "~/components/blocks/catalog";
import { CatalogPanels } from "~/components/blocks/catalog-panels";
import { ignore, renderFrame } from "../frame";
import { definitionItems, triggerItems } from "./fixtures-a";

const selectedTrigger = triggerItems.find((item) => item.selected)?.id;
const selectedDefinition = definitionItems.find((item) => item.selected)?.id;

function Panels() {
  return (
    <CatalogPanels
      catalog={
        <DefinitionsBlock
          active={false}
          items={definitionItems}
          onSelect={ignore}
          selectedId={selectedDefinition}
          workspace="foundry"
        />
      }
      triggers={
        <TriggersBlock
          active
          items={triggerItems}
          onSelect={ignore}
          selectedId={selectedTrigger}
        />
      }
    />
  );
}

export default defineStories({
  component: "CatalogPanels",
  description:
    "Stacks the triggers and catalog panels, giving triggers two fifths of the spare height.",
  title: "Blocks/CatalogPanels",
});

export const Tall = story({
  description:
    "A tall frame: triggers get a fixed share and the catalog grows into the rest.",
  name: "Tall",
  render: (renderer) =>
    renderFrame(renderer, <Panels />, {
      height: 30,
      padded: false,
      width: 90,
    }),
});

export const Short = story({
  description:
    "A short frame: both panels shrink toward their three-row minimum and scroll.",
  name: "Short",
  render: (renderer) =>
    renderFrame(renderer, <Panels />, {
      height: 10,
      padded: false,
      width: 90,
    }),
});

export const VeryShort = story({
  description:
    "A frame so short the selected trigger sits below the first rows; the triggers panel scrolls it into view.",
  name: "Very short",
  render: (renderer) =>
    renderFrame(renderer, <Panels />, {
      height: 8,
      padded: false,
      width: 90,
    }),
});

export const Narrow = story({
  description: "A narrow column, as beside the details panel.",
  name: "Narrow",
  render: (renderer) =>
    renderFrame(
      renderer,
      <CatalogPanels
        catalog={
          <DefinitionsBlock
            active={false}
            compact
            items={definitionItems}
            onSelect={ignore}
            selectedId={selectedDefinition}
            workspace="foundry"
          />
        }
        triggers={
          <TriggersBlock
            active
            compact
            items={triggerItems}
            onSelect={ignore}
            selectedId={selectedTrigger}
          />
        }
      />,
      { height: 22, padded: false, width: 40 }
    ),
});

export const Empty = story({
  description: "A new workspace with nothing in either panel.",
  name: "Empty",
  render: (renderer) =>
    renderFrame(
      renderer,
      <CatalogPanels
        catalog={
          <DefinitionsBlock
            active={false}
            items={[]}
            onSelect={ignore}
            workspace="foundry"
          />
        }
        triggers={<TriggersBlock active items={[]} onSelect={ignore} />}
      />,
      { height: 22, padded: false, width: 90 }
    ),
});
