import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { theme } from "~/components/ui/theme";
export interface PanelHints {
  readonly actions: readonly {
    readonly label: string;
    readonly priority?: boolean;
  }[];
  readonly focus: string;
}

export const PanelShortcuts = createContext<PanelHints | undefined>(undefined);

function fittedShortcuts(
  { focus, actions }: PanelHints,
  available: number
): string | undefined {
  const ordered = actions.toSorted(
    (a, b) => Number(Boolean(b.priority)) - Number(Boolean(a.priority))
  );
  let title = focus;
  for (const action of ordered) {
    const candidate = `${title} · ${action.label}`;
    if (candidate.length <= available) {
      title = candidate;
    }
  }
  return title.length <= available && title ? ` ${title} ` : undefined;
}

export function Panel({
  title,
  id,
  active = false,
  selectedId,
  children,
  scrollable = false,
  resetKey,
  borderHint,
  header,
}: {
  readonly title: string;
  readonly id?: string;
  readonly active?: boolean;
  readonly selectedId?: string;
  readonly scrollable?: boolean;
  readonly resetKey?: string;
  readonly borderHint?: string;
  readonly children: ReactNode;
  readonly header?: ReactNode;
}) {
  const shortcuts = useContext(PanelShortcuts);
  const [width, setWidth] = useState(0);
  const measure = useCallback(function measureFrame(this: BoxRenderable) {
    setWidth(this.width);
  }, []);
  const scroll = useRef<ScrollBoxRenderable>(null);
  useEffect(() => {
    if (selectedId && width > 0) {
      scroll.current?.scrollChildIntoView(selectedId);
    }
  }, [selectedId, width]);
  useEffect(() => {
    if (resetKey) {
      scroll.current?.scrollTo(0);
    }
  }, [resetKey]);
  return (
    <box
      border
      borderColor={active ? theme.border.focusColor : theme.border.color}
      borderStyle={theme.border.style}
      bottomTitle={
        active
          ? (borderHint ?? (shortcuts && fittedShortcuts(shortcuts, width - 5)))
          : undefined
      }
      flexBasis={0}
      flexDirection="column"
      flexGrow={1}
      id={id}
      minHeight={3}
      minWidth={0}
      onSizeChange={measure}
      title={title}
    >
      {header && (
        <box flexDirection="column" flexShrink={0} paddingX={1}>
          {header}
        </box>
      )}
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
