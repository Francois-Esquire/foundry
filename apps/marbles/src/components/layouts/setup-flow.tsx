import type { ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { type ReactNode, useCallback, useRef } from "react";
import { FormFocusProvider } from "~/components/ui/form-focus";
import { theme } from "~/components/ui/theme";

export function SetupFlow({
  children,
  footer,
  maxHeight = 36,
  title,
  overlay,
}: {
  readonly overlay?: ReactNode;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly maxHeight?: number;
  readonly title: string;
}) {
  const scroll = useRef<ScrollBoxRenderable>(null);
  const reveal = useCallback(
    (id: string) => scroll.current?.scrollChildIntoView(id),
    []
  );
  const dimensions = useTerminalDimensions();
  return (
    <box
      alignItems="center"
      backgroundColor={theme.colors.background}
      height="100%"
      justifyContent="center"
      width="100%"
    >
      <box
        border
        borderColor={theme.colors.primary}
        borderStyle="rounded"
        flexDirection="column"
        height={Math.min(maxHeight, Math.max(1, dimensions.height - 2))}
        paddingX={1}
        width={Math.min(80, Math.max(1, dimensions.width - 2))}
      >
        <text fg={theme.colors.primary} flexShrink={0}>
          <strong>marbles · {title}</strong>
        </text>
        <scrollbox
          flexGrow={1}
          ref={scroll}
          scrollX={false}
          viewportCulling={false}
        >
          <FormFocusProvider value={reveal}>{children}</FormFocusProvider>
        </scrollbox>
        {footer}
      </box>
      {overlay}
    </box>
  );
}
