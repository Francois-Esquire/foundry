import { Spinner } from "@/components/blocks/spinner";
import { hud } from "@/model/palette";

export function GoalBar({
  busy,
  draft,
  frame,
  onDraft,
  onSubmit,
}: {
  readonly busy: boolean;
  readonly draft: string;
  readonly frame: number;
  readonly onDraft: (draft: string) => void;
  readonly onSubmit: () => void;
}) {
  return (
    <box flexDirection="row" gap={1} height={1}>
      {busy ? (
        <Spinner frame={frame} />
      ) : (
        <text fg={hud.amber}>
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
  );
}
