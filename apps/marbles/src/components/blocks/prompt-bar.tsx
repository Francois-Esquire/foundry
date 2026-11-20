import { Text } from "~/components/ui/text";
import { TextInput } from "~/components/ui/text-input";

type PromptKind = "steer" | "resume";

function promptLabel(kind: PromptKind, stepId: string): string {
  return kind === "steer"
    ? `steer ${stepId} › `
    : `resume ${stepId} · prompt optional › `;
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
    <box flexDirection="row" height={1}>
      <Text>{promptLabel(kind, stepId)}</Text>
      <TextInput
        flexGrow={1}
        focused={focused}
        onInput={onInput}
        onSubmit={onSubmit}
        value={draft}
      />
      <Text>Enter send · Esc cancel</Text>
    </box>
  );
}
