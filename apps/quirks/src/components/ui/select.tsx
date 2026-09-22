// Adapted from termcn OpenTUI Select: controlled selection, scoped focus, and mouse support.
import { useKeyboard } from "@opentui/react";
import { Action } from "~/components/action";
import { useTheme } from "~/hooks/use-theme";

export function Select({
  options,
  value,
  onChange,
  focused,
  id,
}: {
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
  }[];
  readonly value?: string;
  readonly onChange: (value: string) => void;
  readonly focused: boolean;
  readonly id: string;
}) {
  const theme = useTheme();
  useKeyboard((key) => {
    if (
      !(focused && ["up", "down", "left", "right", "space"].includes(key.name))
    ) {
      return;
    }
    key.preventDefault();
    const index = options.findIndex((option) => option.value === value);
    const direction = key.name === "up" || key.name === "left" ? -1 : 1;
    const next = options[(index + direction + options.length) % options.length];
    if (next) {
      onChange(next.value);
    }
  });
  return (
    <box flexDirection="column">
      {options.map((option) => (
        <box flexDirection="row" key={option.value}>
          <text fg={theme.colors.primary}>
            {option.value === value ? "◆ " : "◇ "}
          </text>
          <Action
            active={focused && option.value === value}
            id={`${id}:${option.value}`}
            label={option.label}
            onAction={onChange}
            value={option.value}
          />
        </box>
      ))}
    </box>
  );
}
