import type { Territory } from "../../data/types";
import type { LabelPlace, MapLabel } from "../../layout/labels";
import type { LabelActivation } from "../../scene/handle";
import { create, type KeyedElements, keyedElements } from "./text-element";

/**
 * The labels layer's items: the list of islands, each holding its name and
 * a list of the labels on it, the captions beside them, the place each
 * focusable item names, and the keyboard activation that selects it.
 */

/** The island items: one per island, always present, each holding its name and the labels on it. */
export interface IslandItem {
  caption: HTMLSpanElement;
  item: HTMLLIElement;
  labels: HTMLUListElement;
  name: HTMLSpanElement;
  nameText: Text;
}

/** The layer's items, as the frame pipeline drives them. */
interface LabelItems {
  dispose: () => void;
  /** The island's item, after the islands as drawn are reconciled. */
  island: (territory: Territory) => IslandItem | undefined;
  /** Every island's item, for the names a frame leaves unplaced. */
  islands: () => Iterable<IslandItem>;
  /** The items for the placed labels other than island names, by what they name. */
  items: KeyedElements<string, MapLabel, HTMLLIElement>;
  /** Sets the place an item names, when it changes: the island as drawn now, since a relayout replaces it. */
  place: (element: HTMLElement, place: LabelPlace) => void;
  setActivation: (handler: LabelActivation | null) => void;
  /** Reconciles the island items with the islands as drawn; a relayout replaces them. */
  update: (territories: readonly Territory[]) => void;
}

/**
 * Removes an item's element. One removed while focused hands its focus to
 * its island, so a keyboard reader is not dropped to the page.
 */
function retire(element: HTMLElement): void {
  if (element.contains(document.activeElement)) {
    element.closest<HTMLElement>(".spyglass-island")?.focus();
  }
  element.remove();
}

/** The key an element is kept by: what it names and says, so a pan or a zoom moves it rather than replacing it. */
function keyOf(label: MapLabel): string {
  const { place } = label;
  const named =
    label.kind === "frame"
      ? label.frame.id
      : (place?.file?.id ?? place?.regionId ?? place?.compositeId ?? "");
  return `${label.kind}|${label.territory?.id ?? ""}|${named}|${label.text}`;
}

/** An island's item: focusable, holding its name (shown when placed) with its caption, and a list for the labels on it. */
function createIslandItem(list: HTMLUListElement): IslandItem {
  const item = create(list, "li", "spyglass-island");
  item.tabIndex = 0;
  const name = create(item, "span", "spyglass-label spyglass-island-name");
  name.hidden = true;
  const nameText = document.createTextNode("");
  name.append(nameText);
  const caption = create(name, "span", "spyglass-caption");
  const labels = create(item, "ul", "spyglass-island-labels");
  return { caption, item, labels, name, nameText };
}

/**
 * A placed label's item, in an island's list or among the captions: named
 * for assistive technology by what it names, and focusable when it names a
 * place.
 */
function createItem(parent: HTMLUListElement, label: MapLabel): HTMLLIElement {
  const element = create(parent, "li", `spyglass-label spyglass-${label.kind}`);
  element.textContent = label.text;
  if (label.kind === "frame") {
    element.setAttribute("aria-label", `${label.frame.label}, frame`);
  } else if (label.place) {
    element.tabIndex = 0;
    element.setAttribute("aria-label", `${label.text}, ${label.kind}`);
  }
  return element;
}

/**
 * Builds the layer's items in its root: the list of islands, one focusable
 * item per island, named for assistive technology with its package and
 * file count, and the list of captions. Enter or Space on a focused item
 * selects the place it names through `setActivation`.
 */
export function createLabelItems(root: HTMLElement): LabelItems {
  const places = new WeakMap<HTMLElement, LabelPlace>();
  const list = create(root, "ul", "spyglass-islands");
  const captions = create(root, "ul", "spyglass-captions");
  let activation: LabelActivation | null = null;
  let territories: readonly Territory[] | undefined;

  const islands = keyedElements<string, Territory, IslandItem>({
    create: () => createIslandItem(list),
    key: (territory) => territory.id,
    retire: (island) => retire(island.item),
  });
  const islandOf = (territory: Territory) => islands.get(territory.id);
  const items = keyedElements<string, MapLabel, HTMLLIElement>({
    create: (label) =>
      createItem(
        (label.place && islandOf(label.place.territory)?.labels) ?? captions,
        label
      ),
    key: keyOf,
    retire,
  });

  const place = (element: HTMLElement, next: LabelPlace) => {
    if (places.get(element) !== next) {
      places.set(element, next);
    }
  };

  const activate = (event: KeyboardEvent) => {
    if (
      root.hidden ||
      root.inert ||
      (event.key !== "Enter" && event.key !== " ")
    ) {
      return;
    }
    const named =
      event.target instanceof HTMLElement ? places.get(event.target) : null;
    if (named && activation) {
      event.preventDefault();
      activation(named);
    }
  };
  root.addEventListener("keydown", activate);

  /** Rebuilds the island items when the islands change, since a relayout replaces them. */
  const build = (next: readonly Territory[]) => {
    territories = next;
    islands.reconcile(next, (island, territory) => {
      const count = territory.files.length;
      island.item.setAttribute(
        "aria-label",
        `${territory.label}, package, ${count.toLocaleString("en")} ${count === 1 ? "file" : "files"}`
      );
      place(island.item, { territory });
    });
  };

  return {
    dispose() {
      root.removeEventListener("keydown", activate);
    },
    island: islandOf,
    *islands() {
      for (const territory of territories ?? []) {
        const island = islandOf(territory);
        if (island) {
          yield island;
        }
      }
    },
    items,
    place,
    setActivation(handler) {
      activation = handler;
    },
    update(next) {
      if (next !== territories) {
        build(next);
      }
    },
  };
}
