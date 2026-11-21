import { useKeyboard } from "@opentui/react";
import { useState } from "react";

export function nextTab<Key extends string>(
  keys: readonly Key[],
  active: Key,
  backwards: boolean
): Key {
  const index = Math.max(keys.indexOf(active), 0);
  const step = backwards ? keys.length - 1 : 1;
  return keys[(index + step) % keys.length] ?? active;
}

export function useTabCycle<Key extends string>(
  keys: readonly [Key, ...Key[]],
  enabled: boolean
): Key {
  const [active, setActive] = useState<Key>(keys[0]);
  useKeyboard((key) => {
    if (enabled && key.name === "tab") {
      setActive((current) => nextTab(keys, current, key.shift));
    }
  });
  return active;
}
