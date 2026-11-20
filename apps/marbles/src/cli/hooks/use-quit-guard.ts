import type { KeyEvent } from "@opentui/core";
import { useCallback, useState } from "react";

export function useQuitGuard(onClose: () => void) {
  const [quitting, setQuitting] = useState(false);
  const ask = useCallback(() => setQuitting(true), []);
  const cancel = useCallback(() => setQuitting(false), []);
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
