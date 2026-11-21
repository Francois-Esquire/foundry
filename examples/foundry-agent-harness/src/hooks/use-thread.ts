import { useCallback, useState } from "react";
import type { Weapon } from "@/model/context";
import type { Run, Thread } from "@/model/thread";
import { emptyThread } from "@/model/thread";

export function useThread(run: Run): {
  readonly start: (goal: string, weapon: Weapon) => void;
  readonly thread: Thread;
} {
  const [thread, setThread] = useState(emptyThread);
  const start = useCallback(
    (goal: string, weapon: Weapon) => {
      run(goal, setThread, weapon);
    },
    [run]
  );
  return { start, thread };
}
