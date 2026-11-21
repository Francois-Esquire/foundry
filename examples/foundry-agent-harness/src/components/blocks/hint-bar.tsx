import { hud } from "@/model/palette";
import type { Notes } from "@/model/thread";

export function HintBar({
  keys,
  notes,
}: {
  readonly keys: readonly (readonly [key: string, action: string])[];
  readonly notes?: Notes;
}) {
  return (
    <box flexDirection="row" gap={1} height={1} paddingX={1}>
      <text fg={hud.dim} flexShrink={0} wrapMode="none">
        {keys.map(([key, action]) => (
          <span key={key}>
            <span bg={hud.tint} fg={hud.amber}>{` ${key} `}</span>
            {` ${action}  `}
          </span>
        ))}
      </text>
      <box flexGrow={1} flexShrink={1} />
      {notes ? (
        <text fg={hud.ok} flexShrink={1} truncate wrapMode="none">
          {`◆ notes ${notes.version} · ${notes.files.length} kept`}
        </text>
      ) : null}
    </box>
  );
}
