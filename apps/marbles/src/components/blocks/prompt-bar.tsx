import { InputRow } from "~/components/ui/input-row";

type PromptKind = "steer" | "resume";

const HINT = "Enter send · Esc cancel";

function promptLabels(kind: PromptKind, stepId: string): readonly string[] {
  const short = `${kind} ${stepId} ›`;
  return kind === "steer"
    ? [short]
    : [`resume ${stepId} · prompt optional ›`, short];
}

type PromptLabels =
  | { readonly labels: readonly string[] }
  | { readonly kind: PromptKind; readonly stepId: string };

export function PromptBar({
  draft,
  focused,
  onInput,
  onSubmit,
  ...label
}: {
  readonly draft: string;
  readonly focused: boolean;
  readonly onInput: (value: string) => void;
  readonly onSubmit: () => void;
} & PromptLabels) {
  return (
    <InputRow
      focused={focused}
      hint={HINT}
      labels={
        "labels" in label
          ? label.labels
          : promptLabels(label.kind, label.stepId)
      }
      onInput={onInput}
      onSubmit={onSubmit}
      value={draft}
    />
  );
}
