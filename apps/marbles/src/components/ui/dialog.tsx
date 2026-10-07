// Adapted from termcn's OpenTUI Dialog.
import type { MouseEvent } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { type ReactNode, useCallback, useState } from "react";
import { Action } from "~/components/ui/action";
import { theme } from "~/components/ui/theme";

function blockMouse(event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
}

/** Mount while open. The host disables background focus and shortcuts. */
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
  const dimensions = useTerminalDimensions();
  const [confirmFocused, setConfirmFocused] = useState(false);
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
      position="absolute"
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
        height={Math.min(18, dimensions.height)}
        id="dialog"
        maxWidth={76}
        paddingX={1}
        width="100%"
      >
        <text fg={color} flexShrink={0} marginBottom={1}>
          <strong>{title}</strong>
        </text>
        <scrollbox
          contentOptions={{ flexDirection: "column", gap: 1 }}
          flexGrow={1}
          focused
          minHeight={1}
          scrollX={false}
        >
          {children}
        </scrollbox>
        <box
          flexDirection="row"
          flexShrink={0}
          gap={2}
          justifyContent="flex-end"
          marginTop={1}
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
        {hint && (
          <text fg={theme.colors.mutedForeground} flexShrink={0}>
            {hint}
          </text>
        )}
      </box>
    </box>
  );
}
