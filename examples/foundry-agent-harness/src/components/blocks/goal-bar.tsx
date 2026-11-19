import { useCallback, useState } from "react";
import { Spinner } from "@/components/blocks/spinner";
import { Panel } from "@/components/ui/panel";
import { useTheme } from "@/hooks/use-theme";

export function GoalBar({
  busy,
  onGoal,
  width,
}: {
  readonly busy: boolean;
  readonly onGoal: (goal: string) => void;
  readonly width: number;
}) {
  const theme = useTheme();
  const [draft, setDraft] = useState("");
  const submit = useCallback(() => {
    const goal = draft.trim();
    if (busy || goal === "") {
      return;
    }
    setDraft("");
    onGoal(goal);
  }, [busy, draft, onGoal]);
  return (
    <Panel width={width}>
      <box flexDirection="row" gap={1}>
        {busy ? (
          <Spinner />
        ) : (
          <text fg={theme.colors.primary}>
            <b>›</b>
          </text>
        )}
        <input
          flexGrow={1}
          focused
          onInput={setDraft}
          onSubmit={submit}
          placeholder={
            busy
              ? "Working. The next goal can go in when this one is done."
              : "Give the harness a goal"
          }
          value={draft}
        />
      </box>
    </Panel>
  );
}
