// Adapted from termcn OpenTUI SetupFlow; theme-aware steps with composable content.

import type { ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
} from "react";
import { useTheme } from "~/hooks/use-theme";

export function SetupFlow({
  children,
  title,
  overlay,
}: {
  readonly overlay?: ReactNode;
  readonly children: ReactNode;
  readonly title: string;
}) {
  const scroll = useRef<ScrollBoxRenderable>(null);
  const reveal = useCallback(
    (id: string) => scroll.current?.scrollChildIntoView(id),
    []
  );
  const theme = useTheme();
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
        height={Math.min(36, Math.max(1, dimensions.height - 2))}
        paddingX={1}
        width={Math.min(80, Math.max(1, dimensions.width - 2))}
      >
        <text fg={theme.colors.primary}>
          <strong>quirks · {title}</strong>
        </text>
        <scrollbox
          flexGrow={1}
          ref={scroll}
          scrollX={false}
          viewportCulling={false}
        >
          <FocusContext.Provider value={reveal}>
            {children}
          </FocusContext.Provider>
        </scrollbox>
      </box>
      {overlay}
    </box>
  );
}

export function SetupStep({
  status,
  children,
}: {
  readonly status: "done" | "active" | "pending" | "error";
  readonly children: ReactNode;
}) {
  const theme = useTheme();
  const color = status === "error" ? theme.colors.error : theme.colors.primary;
  return (
    <box flexDirection="column" marginTop={1}>
      <text fg={status === "pending" ? theme.colors.mutedForeground : color}>
        {status === "active" ? "◆" : "◇"} {children}
      </text>
      <text fg={theme.colors.mutedForeground}>│</text>
    </box>
  );
}

const FocusContext = createContext<((id: string) => void) | undefined>(
  undefined
);
export function useFormFocus(id: string) {
  const reveal = useContext(FocusContext);
  useEffect(() => {
    const timer = setTimeout(() => reveal?.(id), 20);
    return () => clearTimeout(timer);
  }, [id, reveal]);
}
