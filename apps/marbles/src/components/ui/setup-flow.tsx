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
        <text fg={theme.colors.primary}>
          <strong>marbles · {title}</strong>
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
        {footer}
      </box>
      {overlay}
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
