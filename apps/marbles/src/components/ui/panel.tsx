import type { ScrollBoxRenderable } from "@opentui/core";
import { type ReactNode, useEffect, useRef } from "react";
import { theme } from "~/components/ui/theme";

export function Panel({
  title,
  id,
  active = false,
  selectedId,
  children,
  scrollable = false,
  resetKey,
}: {
  readonly title: string;
  readonly id?: string;
  readonly active?: boolean;
  readonly selectedId?: string;
  readonly scrollable?: boolean;
  readonly resetKey?: string;
  readonly children: ReactNode;
}) {
  const scroll = useRef<ScrollBoxRenderable>(null);
  useEffect(() => {
    if (selectedId) {
      scroll.current?.scrollChildIntoView(selectedId);
    }
  }, [selectedId]);
  useEffect(() => {
    if (resetKey) {
      scroll.current?.scrollTo(0);
    }
  }, [resetKey]);
  return (
    <box
      border
      borderColor={active ? theme.border.focusColor : theme.border.color}
      borderStyle="rounded"
      flexBasis={0}
      flexDirection="column"
      flexGrow={1}
      id={id}
      minHeight={3}
      minWidth={0}
      title={title}
    >
      {/* Offscreen rows need layout measurements for keyboard scrolling to nested steps. */}
      <scrollbox
        contentOptions={{ flexDirection: "column", paddingX: 1 }}
        flexGrow={1}
        focused={scrollable}
        ref={scroll}
        scrollX={false}
        viewportCulling={false}
      >
        {children}
      </scrollbox>
    </box>
  );
}
