import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { type RefObject, useRef } from "react";

export function usePageScroll(
  page: number
): RefObject<ScrollBoxRenderable | null> {
  const scroll = useRef<ScrollBoxRenderable>(null);
  useKeyboard((key) => {
    if (key.name === "pageup" || key.name === "pagedown") {
      scroll.current?.scrollBy(key.name === "pageup" ? -page : page);
    }
  });
  return scroll;
}
