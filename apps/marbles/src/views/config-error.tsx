import { useKeyboard } from "@opentui/react";
import { Action } from "~/components/action";
import { SetupFlow } from "~/components/ui/setup-flow";

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
      <text>{message}</text>
      <Action
        label="Enter · Close and fix module"
        onAction={onClose}
        value="close"
      />
    </SetupFlow>
  );
}
