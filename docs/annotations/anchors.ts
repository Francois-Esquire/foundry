import type { Anchor, Point } from "./model.ts";

const BLOCKS = "h1,h2,h3,h4,h5,h6,p,pre,table,li,figure,blockquote";
const HEADING = /^H[1-6]$/;
const WHITESPACE = /\s+/g;

function textHash(text: string): string {
  let hash = 0;
  for (const character of text) {
    hash = (hash * 31 + character.charCodeAt(0)) % 4_294_967_291;
  }
  return hash.toString(36);
}

function distanceToRect(x: number, y: number, rect: DOMRect): number {
  const dx = Math.max(rect.left - x, 0, x - rect.right);
  const dy = Math.max(rect.top - y, 0, y - rect.bottom);
  return dx * dx + dy * dy;
}

/** Stable content identities with live geometry, independent of overlay hit testing. */
export function createAnchors(article: HTMLElement, host: HTMLElement) {
  const elements = new Map<string, HTMLElement>([["article", article]]);
  const occurrences = new Map<string, number>();
  const previousAttributes = new Map<HTMLElement, string | null>();
  let section = "page";

  for (const element of article.querySelectorAll<HTMLElement>(BLOCKS)) {
    if (host.contains(element)) {
      continue;
    }
    if (HEADING.test(element.tagName) && element.id) {
      section = element.id;
    }
    const content = (element.textContent ?? "").replace(WHITESPACE, " ").trim();
    const identity = `${section}:${element.tagName.toLowerCase()}:${textHash(content)}`;
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    const id = `${identity}:${occurrence}`;
    previousAttributes.set(
      element,
      element.getAttribute("data-annotation-anchor")
    );
    element.setAttribute("data-annotation-anchor", id);
    elements.set(id, element);
  }

  function anchorAt(x: number, y: number): Anchor {
    const hostRect = host.getBoundingClientRect();
    const clientX = hostRect.left + x;
    const clientY = hostRect.top + y;
    let selected = "article";
    let nearestDistance = Number.POSITIVE_INFINITY;
    let smallestArea = Number.POSITIVE_INFINITY;

    for (const [id, element] of elements) {
      if (id === "article" || !element.isConnected) {
        continue;
      }
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        continue;
      }
      const distance = distanceToRect(clientX, clientY, rect);
      const area = rect.width * rect.height;
      if (
        distance < nearestDistance ||
        (distance === nearestDistance && area < smallestArea)
      ) {
        selected = id;
        nearestDistance = distance;
        smallestArea = area;
      }
    }

    const target = elements.get(selected) ?? article;
    const rect = target.getBoundingClientRect();
    return {
      id: selected,
      x: (clientX - rect.left) / Math.max(1, rect.width),
      y: (clientY - rect.top) / Math.max(1, rect.height),
    };
  }

  function resolveAnchor(anchor: Anchor): Point | null {
    const element = elements.get(anchor.id);
    if (!element?.isConnected) {
      return null;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    const hostRect = host.getBoundingClientRect();
    return {
      x: rect.left - hostRect.left + rect.width * anchor.x,
      y: rect.top - hostRect.top + rect.height * anchor.y,
    };
  }

  function dispose() {
    for (const [element, previous] of previousAttributes) {
      if (previous === null) {
        element.removeAttribute("data-annotation-anchor");
      } else {
        element.setAttribute("data-annotation-anchor", previous);
      }
    }
    elements.clear();
    previousAttributes.clear();
  }

  return { anchorAt, dispose, resolveAnchor };
}
