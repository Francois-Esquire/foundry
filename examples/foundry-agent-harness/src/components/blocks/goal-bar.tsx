import { Spinner } from "@/components/blocks/spinner";
import { hud } from "@/model/palette";

function placeholderFor(busy: boolean, reviewing: boolean): string {
  if (busy) {
    return "Working. The next goal can go in when this one is done.";
  }
  return reviewing
    ? "Accept, reject or skip the result to give the next goal"
    : "Give the harness a goal";
}

export function GoalBar({
  busy,
  draft,
  frame,
  onDraft,
  onSubmit,
  reviewing,
}: {
  readonly busy: boolean;
  readonly draft: string;
  readonly frame: number;
  readonly onDraft: (draft: string) => void;
  readonly onSubmit: () => void;
  readonly reviewing: boolean;
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
        focused={!reviewing}
        onInput={onDraft}
        onSubmit={onSubmit}
        placeholder={placeholderFor(busy, reviewing)}
        value={draft}
      />
    </box>
  );
}
