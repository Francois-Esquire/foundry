import { useKeyboard } from "@opentui/react";

export function useConfirm(onConfirm: () => void): void {
  useKeyboard((key) => {
    if (key.name === "return" || key.name === "enter") {
      onConfirm();
    }
  });
}
