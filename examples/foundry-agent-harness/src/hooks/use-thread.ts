import { useCallback, useState } from "react";
import type { Run, Thread } from "@/model/thread";
import { emptyThread } from "@/model/thread";

export function useThread(run: Run): {
  readonly start: (goal: string) => void;
  readonly thread: Thread;
} {
  const [thread, setThread] = useState(emptyThread);
  const start = useCallback(
    (goal: string) => {
      run(goal, setThread);
    },
    [run]
  );
  return { start, thread };
}
