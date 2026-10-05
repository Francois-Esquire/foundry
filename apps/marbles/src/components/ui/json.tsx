// Adapted from termcn's OpenTUI JSONView.
import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SelectableRow } from "~/components/selectable-row";
import { Text } from "~/components/ui/text";
import type { JsonValue } from "~/views/dashboard-model";

interface JsonLine {
  readonly branch: boolean;
  readonly depth: number;
  readonly path: string;
  readonly text: string;
}

function linesFor(
  value: JsonValue,
  collapsed: ReadonlySet<string>,
  path: readonly (string | number)[] = [],
  depth = 0,
  label = "root"
): JsonLine[] {
  const id = JSON.stringify(path);
  if (value === null || typeof value !== "object") {
    return [
      {
        branch: false,
        depth,
        path: id,
        text: `${label}: ${JSON.stringify(value)}`,
      },
    ];
  }
  const entries = Array.isArray(value)
    ? value.map((item, index) => [index, item] as const)
    : Object.entries(value);
  const folded = collapsed.has(id);
  const summary = Array.isArray(value)
    ? `[${entries.length} items]`
    : `{${entries.length} fields}`;
  const row = {
    branch: true,
    depth,
    path: id,
    text: `${folded ? "▸" : "▾"} ${label} ${summary}`,
  };
  if (folded) {
    return [row];
  }
  return [
    row,
    ...entries.flatMap(([key, item]) =>
      linesFor(item, collapsed, [...path, key], depth + 1, String(key))
    ),
  ];
}

export function JSONView({
  data,
  focused,
}: {
  readonly data: JsonValue;
  readonly focused: boolean;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [cursor, setCursor] = useState("[]");
  const scroll = useRef<ScrollBoxRenderable>(null);
  const lines = linesFor(data, collapsed);
  const index = Math.max(
    0,
    lines.findIndex((line) => line.path === cursor)
  );
  const current = lines[index];
  const toggle = useCallback((path: string) => {
    setCursor(path);
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);
  useKeyboard((key) => {
    if (!focused) {
      return;
    }
    if (key.name === "space" && current?.branch) {
      key.preventDefault();
      toggle(current.path);
    }
    if (key.name === "up" || key.name === "down") {
      key.preventDefault();
      const next =
        lines[
          Math.max(
            0,
            Math.min(lines.length - 1, index + (key.name === "down" ? 1 : -1))
          )
        ];
      if (next) {
        setCursor(next.path);
      }
    }
  });
  useEffect(() => {
    scroll.current?.scrollChildIntoView(`json:${cursor}`);
  }, [cursor]);
  return (
    <scrollbox height={8} ref={scroll} scrollX={false} viewportCulling={false}>
      {lines.map((line) => (
        <SelectableRow
          depth={line.depth}
          id={`json:${line.path}`}
          key={line.path}
          onSelect={line.branch ? toggle : setCursor}
          selected={focused && current?.path === line.path}
          value={line.path}
        >
          <Text>{line.text}</Text>
        </SelectableRow>
      ))}
    </scrollbox>
  );
}
