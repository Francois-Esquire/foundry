// Adapted from termcn.
/* @jsxImportSource @opentui/react */

import type { ReactNode } from "react";
import { useMemo } from "react";

import { theme } from "~/components/ui/theme";

interface KeyValueItem {
  color?: string;
  key: string;
  value: ReactNode;
}

export interface KeyValueProps {
  items: readonly KeyValueItem[];
  keyColor?: string;
  keyWidth?: number;
  separator?: string;
  valueColor?: string;
}

export const KeyValue = ({
  items,
  keyWidth,
  separator = ":",
  keyColor,
  valueColor,
}: KeyValueProps) => {
  const resolvedKeyWidth = useMemo(() => {
    if (keyWidth !== undefined) {
      return keyWidth;
    }
    let max = 0;
    for (const item of items) {
      max = Math.max(max, item.key.length);
    }
    return max + 1;
  }, [items, keyWidth]);

  const resolvedKeyColor = keyColor ?? theme.colors.mutedForeground;
  const resolvedValueColor = valueColor ?? theme.colors.foreground;

  return (
    <box flexDirection="column">
      {items.map((item) => {
        const paddedKey = item.key.padEnd(resolvedKeyWidth, " ");
        return (
          <box flexDirection="row" gap={1} key={item.key}>
            <text fg={resolvedKeyColor}>{paddedKey}</text>
            <text fg={resolvedKeyColor}>{separator}</text>
            <text fg={item.color ?? resolvedValueColor}>{item.value}</text>
          </box>
        );
      })}
    </box>
  );
};
