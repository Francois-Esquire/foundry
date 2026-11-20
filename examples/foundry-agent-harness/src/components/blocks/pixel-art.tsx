import type { ArtRow } from "@/model/pixels";

export function PixelArt({ rows }: { readonly rows: readonly ArtRow[] }) {
  return (
    <box flexDirection="column" flexShrink={0}>
      {rows.map((row) => (
        <text key={row.key} wrapMode="none">
          {row.runs.map((run) => (
            <span bg={run.bg} fg={run.fg} key={run.key}>
              {run.bold ? <b>{run.text}</b> : run.text}
            </span>
          ))}
        </text>
      ))}
    </box>
  );
}
