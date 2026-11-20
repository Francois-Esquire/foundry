import type { BoxRenderable } from "@opentui/core";
import { useCallback, useState } from "react";
import { Text } from "~/components/ui/text";
import { TextInput } from "~/components/ui/text-input";

type PromptKind = "steer" | "resume";

const HINT = "Enter send · Esc cancel";
const MIN_DRAFT_WIDTH = 12;

function promptLabels(kind: PromptKind, stepId: string): readonly string[] {
  const short = `${kind} ${stepId} › `;
  return kind === "steer"
    ? [short]
    : [`resume ${stepId} · prompt optional › `, short];
}

function fittedLabel(labels: readonly string[], width: number): string {
  const full = labels[0] ?? "";
  if (width === 0) {
    return full;
  }
  return (
    labels.find((label) => label.length + MIN_DRAFT_WIDTH <= width) ??
    labels.at(-1) ??
    full
  );
}

export function PromptBar({
  kind,
  stepId,
  draft,
  focused,
  onInput,
  onSubmit,
}: {
  readonly kind: PromptKind;
  readonly stepId: string;
  readonly draft: string;
  readonly focused: boolean;
  readonly onInput: (value: string) => void;
  readonly onSubmit: () => void;
}) {
  const [width, setWidth] = useState(0);
  const measure = useCallback(function measureBar(this: BoxRenderable) {
    setWidth(this.width);
  }, []);
  const labels = promptLabels(kind, stepId);
  const label = fittedLabel(labels, width);
  const showsHint =
    label === labels[0] &&
    width >= label.length + MIN_DRAFT_WIDTH + HINT.length;
  return (
    <box flexDirection="row" height={1} onSizeChange={measure}>
      <Text flexShrink={1} minWidth={0} truncate wrapMode="none">
        {label}
      </Text>
      <TextInput
        flexBasis={0}
        flexGrow={1}
        flexShrink={0}
        focused={focused}
        minWidth={MIN_DRAFT_WIDTH}
        onInput={onInput}
        onSubmit={onSubmit}
        value={draft}
      />
      {showsHint && <Text flexShrink={0}>{HINT}</Text>}
    </box>
  );
}
