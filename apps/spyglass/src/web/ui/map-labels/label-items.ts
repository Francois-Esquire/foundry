import type { Territory } from "../../data/types";
import type {
  LabelActivation,
  LabelPlace,
  MapLabel,
} from "../../layout/labels";
import { create, type KeyedElements, keyedElements } from "./text-element";

export interface IslandItem {
  caption: HTMLSpanElement;
  item: HTMLLIElement;
  labels: HTMLUListElement;
  name: HTMLSpanElement;
  nameText: Text;
}

interface LabelItems {
  dispose: () => void;
  island: (territory: Territory) => IslandItem | undefined;
  islands: () => Iterable<IslandItem>;
  items: KeyedElements<string, MapLabel, HTMLLIElement>;
  place: (element: HTMLElement, place: LabelPlace) => void;
  setActivation: (handler: LabelActivation | null) => void;
  update: (territories: readonly Territory[]) => void;
}

function retire(element: HTMLElement): void {
  if (element.contains(document.activeElement)) {
    element.closest<HTMLElement>(".spyglass-island")?.focus();
  }
  element.remove();
}

function keyOf(label: MapLabel): string {
  const { place } = label;
  const named =
    label.kind === "frame" ? label.frame.id : (place?.file?.id ?? "");
  return `${label.kind}|${label.territory?.id ?? ""}|${named}|${label.text}`;
}

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
