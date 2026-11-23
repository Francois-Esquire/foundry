import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import type { Verdict } from "@/game/rules";
import { type Encounter, isEnded } from "@/model/thread";

const KEYS: Readonly<Record<string, Verdict>> = {
  a: "accept",
  escape: "skip",
  r: "reject",
};

export function useVerdicts(
  latest: Encounter | undefined
): ReadonlyMap<string, Verdict> {
  const [verdicts, setVerdicts] = useState<ReadonlyMap<string, Verdict>>(
    () => new Map()
  );
  useKeyboard((key) => {
    const verdict = key.ctrl || key.meta ? undefined : KEYS[key.name];
    if (!(verdict && latest && isEnded(latest))) {
      return;
    }
    const { id } = latest;
    setVerdicts((current) =>
      current.has(id) ? current : new Map(current).set(id, verdict)
    );
  });
  return verdicts;
}
