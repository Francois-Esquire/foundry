import { Spinner } from "@/components/blocks/spinner";
import { Panel } from "@/components/ui/panel";
import { useTheme } from "@/hooks/use-theme";

export function GoalBar({
  busy,
  draft,
  frame,
  onDraft,
  onSubmit,
  width,
}: {
  readonly busy: boolean;
  readonly draft: string;
  readonly frame: number;
  readonly onDraft: (draft: string) => void;
  readonly onSubmit: () => void;
  readonly width: number;
}) {
  const theme = useTheme();
  return (
    <Panel width={width}>
      <box flexDirection="row" gap={1}>
        {busy ? (
          <Spinner frame={frame} />
        ) : (
          <text fg={theme.colors.primary}>
            <b>›</b>
          </text>
        )}
        <input
          flexGrow={1}
          focused
          onInput={onDraft}
          onSubmit={onSubmit}
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
