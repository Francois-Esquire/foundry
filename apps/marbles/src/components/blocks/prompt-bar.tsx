import { InputRow } from "~/components/ui/input-row";

type PromptKind = "steer" | "resume";

const HINT = "Enter send · Esc cancel";

function promptLabels(kind: PromptKind, stepId: string): readonly string[] {
  const short = `${kind} ${stepId} ›`;
  return kind === "steer"
    ? [short]
    : [`resume ${stepId} · prompt optional ›`, short];
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
  return (
    <InputRow
      focused={focused}
      hint={HINT}
      labels={promptLabels(kind, stepId)}
      onInput={onInput}
      onSubmit={onSubmit}
      value={draft}
    />
  );
}
