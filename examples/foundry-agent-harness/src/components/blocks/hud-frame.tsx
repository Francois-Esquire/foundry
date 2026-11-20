import { useTheme } from "@/hooks/use-theme";
import type { FrameSegment, FrameTone } from "@/model/hud";

export function HudFrame({
  rows,
}: {
  readonly rows: readonly (readonly FrameSegment[])[];
}) {
  const theme = useTheme();
  const colors: Record<FrameTone, string> = {
    label: theme.colors.primary,
    line: theme.colors.border,
    meta: theme.colors.mutedForeground,
    stud: theme.colors.accent,
  };
  return (
    <box flexDirection="column" left={0} position="absolute" top={0}>
      {rows.map((row, y) => (
        <text key={`row-${y}`} selectable={false} wrapMode="none">
          {row.map((segment, index) => (
            <span fg={colors[segment.tone]} key={`${y}-${index}`}>
              {segment.tone === "label" ? <b>{segment.text}</b> : segment.text}
            </span>
          ))}
        </text>
      ))}
    </box>
  );
}
