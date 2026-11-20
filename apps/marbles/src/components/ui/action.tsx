import type { MouseEvent } from "@opentui/core";
import { useCallback } from "react";
import { theme } from "~/components/ui/theme";

const SHRINKS = { flexDirection: "row", flexShrink: 1, minWidth: 0 } as const;
const TRUNCATES = { minWidth: 0, truncate: true, wrapMode: "none" } as const;

export function Action<T>({
  label,
  value,
  onAction,
  active = false,
  id,
  truncate = false,
}: {
  readonly label: string;
  readonly value: T;
  readonly onAction: (value: T) => void;
  readonly active?: boolean;
  readonly id?: string;
  readonly truncate?: boolean;
}) {
  const press = useCallback(
    (event: MouseEvent) => {
      event.stopPropagation();
      onAction(value);
    },
    [onAction, value]
  );
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Terminal action; its host exposes the equivalent key binding.
    <box flexShrink={0} id={id} onMouseDown={press} {...(truncate && SHRINKS)}>
      <text
        fg={active ? theme.colors.primary : theme.colors.mutedForeground}
        {...(truncate && TRUNCATES)}
      >
        {active ? <strong>{label}</strong> : label}
      </text>
    </box>
  );
}
