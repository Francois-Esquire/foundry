import { useKeyboard } from "@opentui/react";
import { Action } from "~/components/ui/action";
import { SetupFlow } from "~/components/ui/setup-flow";
import { Text } from "~/components/ui/text";

export function ConfigErrorView({
  message,
  onClose,
}: {
  readonly message: string;
  readonly onClose: () => void;
}) {
  useKeyboard((key) => {
    if (
      ["q", "escape", "return", "enter"].includes(key.name) ||
      (key.ctrl && key.name === "c")
    ) {
      onClose();
    }
  });
  return (
    <SetupFlow title="Marbles could not load">
      <Text>{message}</Text>
      <Action
        label="Enter · Close and fix module"
        onAction={onClose}
        value="close"
      />
    </SetupFlow>
  );
}
