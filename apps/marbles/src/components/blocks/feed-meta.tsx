import { Badge } from "~/components/ui/badge";
import { theme } from "~/components/ui/theme";

type FeedMetaTone = "attention" | "info" | "settled" | "success";

export interface FeedMeta {
  readonly label: string;
  readonly tone: FeedMetaTone;
}

const TONE_COLORS = {
  info: "info",
  settled: "secondary",
  success: "success",
} as const;

export function FeedMetaLine({
  meta,
  details,
}: {
  readonly meta: FeedMeta;
  readonly details: readonly (string | undefined)[];
}) {
  const shown = details.filter(
    (detail): detail is string => detail !== undefined && detail !== ""
  );
  return (
    <box
      columnGap={1}
      flexDirection="row"
      flexShrink={1}
      flexWrap="wrap"
      minWidth={0}
    >
      {meta.tone === "attention" ? (
        <Badge variant="warning">{meta.label}</Badge>
      ) : (
        <text
          fg={theme.colors[TONE_COLORS[meta.tone]]}
          flexShrink={0}
          wrapMode="none"
        >
          {meta.label}
        </text>
      )}
      {shown.map((detail) => (
        <text
          fg={theme.colors.mutedForeground}
          flexShrink={0}
          key={detail}
          wrapMode="none"
        >
          {`· ${detail}`}
        </text>
      ))}
    </box>
  );
}
