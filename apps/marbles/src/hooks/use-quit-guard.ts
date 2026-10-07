import type { KeyEvent } from "@opentui/core";
import { useCallback, useState } from "react";

/**
 * Quitting asks first. Ctrl+C opens the confirmation and a second Ctrl+C
 * quits; while it is open every other key belongs to the dialog. Views call
 * `ask` for their own quit key and render the dialog while `quitting`.
 */
export function useQuitGuard(onClose: () => void) {
  const [quitting, setQuitting] = useState(false);
  const ask = useCallback(() => setQuitting(true), []);
  const cancel = useCallback(() => setQuitting(false), []);
  /** True when the key is spent: Ctrl+C, or anything while confirming. */
  function handleKey(key: KeyEvent): boolean {
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      if (key.repeated) {
        return true;
      }
      if (quitting) {
        onClose();
      } else {
        setQuitting(true);
      }
      return true;
    }
    return quitting;
  }
  return { ask, cancel, handleKey, quitting };
}
