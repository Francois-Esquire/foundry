import { useCallback, useState } from "react";

export function useGoalDraft({
  busy,
  onGoal,
}: {
  readonly busy: boolean;
  readonly onGoal: (goal: string) => void;
}): {
  readonly draft: string;
  readonly setDraft: (draft: string) => void;
  readonly submit: () => void;
} {
  const [draft, setDraft] = useState("");
  const submit = useCallback(() => {
    const goal = draft.trim();
    if (busy || goal === "") {
      return;
    }
    setDraft("");
    onGoal(goal);
  }, [busy, draft, onGoal]);
  return { draft, setDraft, submit };
}
