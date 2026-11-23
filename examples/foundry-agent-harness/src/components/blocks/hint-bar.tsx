import { hud } from "@/model/palette";
import type { Notes } from "@/model/thread";

type Keys = readonly (readonly [key: string, action: string])[];

const PADDING = 2;
const GAP = 1;

function notesFor(notes: Notes | undefined, room: number): string | null {
  if (!notes) {
    return null;
  }
  const kept = `${notes.files.length} kept`;
  return (
    [`◆ notes ${notes.version} · ${kept}`, `◆ ${kept}`].find(
      (line) => line.length <= room
    ) ?? null
  );
}

function keysWidth(keys: Keys): number {
  return keys.reduce(
    (sum, [key, action]) => sum + key.length + action.length + 5,
    0
  );
}

export function HintBar({
  keys,
  notes,
  width,
}: {
  readonly keys: Keys;
  readonly notes?: Notes;
  readonly width: number;
}) {
  const noted = notesFor(notes, width - PADDING - GAP - keysWidth(keys));
  return (
    <box flexDirection="row" gap={GAP} height={1} paddingX={1}>
      <text fg={hud.dim} flexShrink={0} wrapMode="none">
        {keys.map(([key, action]) => (
          <span key={key}>
            <span bg={hud.tint} fg={hud.amber}>{` ${key} `}</span>
            {` ${action}  `}
          </span>
        ))}
      </text>
      <box flexGrow={1} flexShrink={1} />
      {noted ? (
        <text fg={hud.ok} flexShrink={0} wrapMode="none">
          {noted}
        </text>
      ) : null}
    </box>
  );
}
