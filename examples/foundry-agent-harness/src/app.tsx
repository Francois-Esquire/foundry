import { useCallback, useState } from "react";
import type { Context } from "@/model/context";
import type { Run } from "@/model/thread";
import { emptyThread } from "@/model/thread";
import { HarnessView } from "@/views/harness";

export function App({
  context,
  run,
}: {
  readonly context: Context;
  readonly run: Run;
}) {
  const [thread, setThread] = useState(emptyThread);
  const start = useCallback(
    (goal: string) => {
      run(goal, setThread);
    },
    [run]
  );
  return <HarnessView context={context} onGoal={start} thread={thread} />;
}
