import type { BoxRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Text } from "./text";
import { TextInput } from "./text-input";

const MIN_INPUT_WIDTH = 12;
const GAP = 1;

interface InputRowFit {
  readonly label: string;
  readonly showsHint: boolean;
}

export function fitInputRow(
  labels: readonly string[],
  hint: string | undefined,
  width: number
): InputRowFit {
  const trimmed = labels.map((entry) => entry.trimEnd());
  const full = trimmed[0] ?? "";
  if (width <= 0) {
    return { label: full, showsHint: false };
  }
  const label =
    trimmed.find((entry) => entry.length + GAP + MIN_INPUT_WIDTH <= width) ??
    trimmed.at(-1) ??
    full;
  const showsHint =
    hint !== undefined &&
    label === full &&
    width >= full.length + GAP + MIN_INPUT_WIDTH + GAP + hint.length;
  return { label, showsHint };
}

export function InputRow({
  labels,
  hint,
  value,
  focused,
  onInput,
  onSubmit,
}: {
  readonly labels: readonly string[];
  readonly hint?: string;
  readonly value: string;
  readonly focused: boolean;
  readonly onInput: (value: string) => void;
  readonly onSubmit: () => void;
}) {
  const renderer = useRenderer();
  const row = useRef<BoxRenderable>(null);
  const measured = useRef(0);
  const [width, setWidth] = useState(0);
  const resize = useCallback((next: number) => {
    if (next !== measured.current) {
      measured.current = next;
      setWidth(next);
    }
  }, []);
  useLayoutEffect(() => {
    renderer.root.calculateLayout();
    resize(Math.floor(row.current?.getLayoutNode().getComputedWidth() ?? 0));
  }, [renderer, resize]);
  const measure = useCallback(
    function measureRow(this: BoxRenderable) {
      resize(this.width);
    },
    [resize]
  );
  const fit = fitInputRow(labels, hint, width);
  return (
    <box flexDirection="row" height={1} onSizeChange={measure} ref={row}>
      <Text flexShrink={1} minWidth={0} truncate wrapMode="none">
        {fit.label}
      </Text>
      <TextInput
        flexBasis={0}
        flexGrow={1}
        flexShrink={0}
        focused={focused}
        marginLeft={GAP}
        minWidth={MIN_INPUT_WIDTH}
        onInput={onInput}
        onSubmit={onSubmit}
        scrollMargin={0}
        value={value}
      />
      {fit.showsHint && (
        <Text flexShrink={0} marginLeft={GAP}>
          {hint}
        </Text>
      )}
    </box>
  );
}
