import { Spinner } from "@/components/blocks/spinner";
import { hud } from "@/model/palette";

const PROMPT = 2;

const PLACEHOLDERS = {
  busy: ["Working. The next goal can go in when this one is done.", "Working"],
  idle: ["Give the harness a goal", "Goal"],
  reviewing: [
    "Accept, reject or skip the result to give the next goal",
    "Rate the result first",
  ],
} as const;

function placeholderFor(
  busy: boolean,
  reviewing: boolean,
  width: number
): string {
  const idle = reviewing ? PLACEHOLDERS.reviewing : PLACEHOLDERS.idle;
  const [full, short] = busy ? PLACEHOLDERS.busy : idle;
  return full.length <= width - PROMPT ? full : short;
}

export function GoalBar({
  busy,
  draft,
  frame,
  onDraft,
  onSubmit,
  reviewing,
  width,
}: {
  readonly busy: boolean;
  readonly draft: string;
  readonly frame: number;
  readonly onDraft: (draft: string) => void;
  readonly onSubmit: () => void;
  readonly reviewing: boolean;
  readonly width: number;
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
        flexShrink={1}
        focused={!reviewing}
        onInput={onDraft}
        onSubmit={onSubmit}
        placeholder={placeholderFor(busy, reviewing, width)}
        value={draft}
      />
    </box>
  );
}
