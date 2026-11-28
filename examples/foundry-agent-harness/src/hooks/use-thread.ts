import { useCallback, useState } from "react";
import type { Loadout } from "@/model/context";
import type { Run, Thread } from "@/model/thread";
import { emptyThread } from "@/model/thread";

export function useThread(run: Run): {
  readonly start: (goal: string, loadout: Loadout) => void;
  readonly thread: Thread;
} {
  const [thread, setThread] = useState(emptyThread);
  const start = useCallback(
    (goal: string, loadout: Loadout) => {
      run(goal, setThread, loadout);
    },
    [run]
  );
  return { start, thread };
}
