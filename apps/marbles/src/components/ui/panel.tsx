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
import { useTheme } from "./theme-provider";

export const PanelShortcuts = createContext<string | undefined>(undefined);

const PRIORITY_SHORTCUT = /^(?:[pskur] |Enter read|[1-9](?:-[1-9])? answer)/;

function fittedShortcuts(hints: string, available: number): string | undefined {
  const [focus, ...actions] = hints.split(" · ");
  const ordered = [
    ...actions.filter((action) => PRIORITY_SHORTCUT.test(action)),
    ...actions.filter((action) => !PRIORITY_SHORTCUT.test(action)),
  ];
  let title = focus ?? "";
  for (const action of ordered) {
    const candidate = `${title} · ${action}`;
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
  const palette = useTheme();
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
      borderStyle={palette?.border.style ?? theme.border.style}
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
