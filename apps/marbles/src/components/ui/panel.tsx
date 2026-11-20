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
import { cellWidth, cutToCells } from "~/components/ui/cells";
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
    if (cellWidth(candidate) <= available) {
      title = candidate;
    }
  }
  return cellWidth(title) <= available && title ? ` ${title} ` : undefined;
}

const TITLE_CHROME = 4;

function fittedTitle(title: string, width: number): string {
  const available = width - TITLE_CHROME;
  if (width === 0 || cellWidth(title) <= available) {
    return title;
  }
  return available > 1 ? `${cutToCells(title, available - 1).trimEnd()}…` : "";
}

const HINT_MIN = 3;
const HINT_TAIL = /[\s·]+$/u;

function fittedHint(hint: string, width: number): string | undefined {
  const available = width - TITLE_CHROME;
  if (width === 0 || cellWidth(hint) <= available) {
    return hint;
  }
  const text = hint.trim();
  const padded = text !== hint;
  const room = available - (padded ? 2 : 0) - 1;
  if (room < HINT_MIN) {
    return;
  }
  const cut = `${cutToCells(text, room).replace(HINT_TAIL, "")}…`;
  return padded ? ` ${cut} ` : cut;
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
  const [height, setHeight] = useState(0);
  const [headerBox, setHeaderBox] = useState({
    height: 0,
    pinned: true,
    width: 0,
  });
  const measure = useCallback(function measureFrame(this: BoxRenderable) {
    setWidth(this.width);
    setHeight(this.height);
  }, []);
  const bodyHeaderHeight = useRef<number | undefined>(undefined);
  const measurePinnedHeader = useCallback(function pinnedHeaderSize(
    this: BoxRenderable
  ) {
    bodyHeaderHeight.current = undefined;
    setHeaderBox({ height: this.height, pinned: true, width: this.width });
  }, []);
  const measureBodyHeader = useCallback(function bodyHeaderSize(
    this: BoxRenderable
  ) {
    const changed =
      bodyHeaderHeight.current !== undefined &&
      bodyHeaderHeight.current !== this.height;
    bodyHeaderHeight.current = this.height;
    setHeaderBox((box) => ({
      ...box,
      pinned: false,
      width: changed ? -1 : box.width,
    }));
  }, []);
  const scroll = useRef<ScrollBoxRenderable>(null);
  const pinned =
    height === 0 ||
    headerBox.width !== width - 2 ||
    height - 2 - headerBox.height > 0;
  const hint =
    borderHint === undefined
      ? shortcuts && fittedShortcuts(shortcuts, width - 5)
      : fittedHint(borderHint, width);
  const headerPlace = useRef(headerBox.pinned);
  useEffect(() => {
    if (headerPlace.current !== headerBox.pinned) {
      headerPlace.current = headerBox.pinned;
      scroll.current?.scrollTo(0);
    }
    if (selectedId && width > 0 && height > 0) {
      scroll.current?.scrollChildIntoView(selectedId);
    }
  }, [selectedId, width, height, headerBox]);
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
      bottomTitle={active ? hint : undefined}
      flexBasis={0}
      flexDirection="column"
      flexGrow={1}
      id={id}
      minHeight={3}
      minWidth={0}
      onSizeChange={measure}
      overflow="hidden"
      title={fittedTitle(title, width)}
    >
      {header && pinned && (
        <box
          flexDirection="column"
          flexShrink={0}
          onSizeChange={measurePinnedHeader}
          paddingX={1}
        >
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
        wrapperOptions={{ flexBasis: 0 }}
      >
        {header && !pinned && (
          <box
            flexDirection="column"
            flexShrink={0}
            onSizeChange={measureBodyHeader}
          >
            {header}
          </box>
        )}
        {children}
      </scrollbox>
    </box>
  );
}
