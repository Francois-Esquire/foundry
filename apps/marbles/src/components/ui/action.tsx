import type { MouseEvent } from "@opentui/core";
import { useCallback } from "react";
import { theme } from "~/components/ui/theme";

/** Mouse action with keyboard equivalents supplied by the containing view. */
export function Action<T>({
  label,
  value,
  onAction,
  active = false,
  id,
}: {
  readonly label: string;
  readonly value: T;
  readonly onAction: (value: T) => void;
  readonly active?: boolean;
  readonly id?: string;
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
    <box flexShrink={0} id={id} onMouseDown={press}>
      <text fg={active ? theme.colors.primary : theme.colors.mutedForeground}>
        {active ? <strong>{label}</strong> : label}
      </text>
    </box>
  );
}
