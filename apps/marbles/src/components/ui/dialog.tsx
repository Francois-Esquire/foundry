import type {
  BoxRenderable,
  MouseEvent,
  ScrollBoxRenderable,
} from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import {
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Action } from "~/components/ui/action";
import { cellWidth } from "~/components/ui/cells";
import { theme } from "~/components/ui/theme";

const MAX_HEIGHT = 18;
const MAX_WIDTH = 76;
const FRAME_COLUMNS = 4;
const FRAME_ROWS = 2;
const BODY_ROWS = 1;
const BUTTON_ROWS = 1;
const GAP_ROWS = 2;
const CONTENT_OPTIONS = {
  flexDirection: "column",
  gap: 1,
  minHeight: 0,
} as const;
const SCROLLBAR_OPTIONS = { marginLeft: 1 } as const;
const WRAPPER_OPTIONS = { flexBasis: 0, minWidth: 0 } as const;

interface Size {
  readonly height: number;
  readonly width: number;
}

function blockMouse(event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
}

function wrappedRows(text: string, width: number): number {
  let rows = 1;
  let used = 0;
  for (const word of text.split(" ")) {
    const cells = cellWidth(word);
    const needed = used === 0 ? cells : used + 1 + cells;
    if (needed <= width) {
      used = needed;
    } else {
      rows += used === 0 ? 0 : 1;
      rows += Math.max(0, Math.ceil(cells / width) - 1);
      used = cells % width || width;
    }
  }
  return rows;
}

function fit(size: Size | undefined, title: string, hint: string | undefined) {
  const known = size !== undefined && size.width > FRAME_COLUMNS;
  const width =
    Math.min(MAX_WIDTH, known ? size.width : MAX_WIDTH) - FRAME_COLUMNS;
  const height = Math.min(MAX_HEIGHT, known ? size.height : MAX_HEIGHT);
  const framed = FRAME_ROWS + wrappedRows(title, width) + BUTTON_ROWS;
  const gaps = height >= framed + BODY_ROWS + GAP_ROWS;
  const hintRows = hint === undefined ? 0 : wrappedRows(hint, width);
  const showsHint =
    hintRows > 0 && height >= framed + BODY_ROWS + GAP_ROWS + hintRows;
  const fixed = framed + (gaps ? GAP_ROWS : 0) + (showsHint ? hintRows : 0);
  return { body: Math.max(0, height - fixed), gaps, hint: showsHint };
}

function sameSize(a: Size | undefined, b: Size) {
  return a?.width === b.width && a.height === b.height;
}

export function Dialog({
  title,
  children,
  confirmLabel = "OK",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  variant = "default",
  hint,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly variant?: "default" | "danger";
  readonly hint?: string;
}) {
  const content = useRef<ScrollBoxRenderable>(null);
  const backdrop = useRef<BoxRenderable>(null);
  const [confirmFocused, setConfirmFocused] = useState(false);
  const [size, setSize] = useState<Size>();
  const resize = useCallback((next: Size) => {
    setSize((previous) => (sameSize(previous, next) ? previous : next));
  }, []);
  const measure = useCallback(
    function measureBackdrop(this: BoxRenderable) {
      resize({ height: this.height, width: this.width });
    },
    [resize]
  );
  useLayoutEffect(() => {
    const parent = backdrop.current?.parent;
    if (parent && parent.width > 0 && parent.height > 0) {
      resize({ height: parent.height, width: parent.width });
    }
  }, [resize]);
  const shown = fit(size, title, hint);
  const bodyShown = shown.body > 0;
  useLayoutEffect(() => {
    if (bodyShown) {
      content.current?.focus();
    }
  }, [bodyShown]);
  const choose = useCallback(
    (confirm: boolean) => {
      if (confirm) {
        onConfirm();
      } else {
        onCancel();
      }
    },
    [onCancel, onConfirm]
  );
  useKeyboard((key) => {
    switch (key.name) {
      case "tab":
      case "left":
      case "right":
        key.preventDefault();
        setConfirmFocused((previous) => !previous);
        break;
      case "return":
      case "enter":
        key.preventDefault();
        choose(confirmFocused);
        break;
      case "escape":
        key.preventDefault();
        onCancel();
        break;
      default:
        break;
    }
  });
  const color =
    variant === "danger" ? theme.colors.error : theme.colors.primary;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Modal backdrop blocks mouse events; keyboard actions are handled above.
    <box
      alignItems="center"
      backgroundColor={`${theme.colors.background}e6`}
      height="100%"
      justifyContent="center"
      left={0}
      onMouseDown={blockMouse}
      onMouseScroll={blockMouse}
      onSizeChange={measure}
      position="absolute"
      ref={backdrop}
      top={0}
      width="100%"
      zIndex={10}
    >
      <box
        backgroundColor={theme.colors.background}
        border
        borderColor={color}
        borderStyle={theme.border.style}
        flexDirection="column"
        flexShrink={1}
        id="dialog"
        maxHeight={MAX_HEIGHT}
        maxWidth={MAX_WIDTH}
        overflow="hidden"
        paddingX={1}
        width="100%"
      >
        <text fg={color} flexShrink={0} marginBottom={shown.gaps ? 1 : 0}>
          <strong>{title}</strong>
        </text>
        <scrollbox
          contentOptions={CONTENT_OPTIONS}
          flexShrink={1}
          maxHeight={shown.body}
          minHeight={Math.min(BODY_ROWS, shown.body)}
          ref={content}
          scrollX={false}
          verticalScrollbarOptions={SCROLLBAR_OPTIONS}
          visible={bodyShown}
          wrapperOptions={WRAPPER_OPTIONS}
        >
          {children}
        </scrollbox>
        <box
          flexDirection="row"
          flexShrink={0}
          gap={2}
          justifyContent="flex-end"
          marginTop={shown.gaps ? 1 : 0}
        >
          <Action
            active={!confirmFocused}
            id="dialog:cancel"
            label={`[ ${cancelLabel} ]`}
            onAction={choose}
            value={false}
          />
          <Action
            active={confirmFocused}
            id="dialog:confirm"
            label={`[ ${confirmLabel} ]`}
            onAction={choose}
            value
          />
        </box>
        {shown.hint && (
          <text fg={theme.colors.mutedForeground} flexShrink={0}>
            {hint}
          </text>
        )}
      </box>
    </box>
  );
}
