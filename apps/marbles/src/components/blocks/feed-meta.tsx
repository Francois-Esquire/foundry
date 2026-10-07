import { theme } from "~/components/ui/theme";
import type { FeedEntrySnapshot } from "~/lib/feed/read";

type KindEntry = Pick<FeedEntrySnapshot, "kind" | "input">;

/** Waiting on someone outside the run: an open question. */
export function isPending(entry: KindEntry): boolean {
  return entry.input?.status === "open";
}

/** An input entry reads by what it needs now, not by its kind. */
function kindStyle(entry: KindEntry): {
  readonly label: string;
  readonly color: string;
} {
  if (entry.kind === "result") {
    return { color: theme.colors.success, label: "result" };
  }
  if (entry.kind === "milestone") {
    return { color: theme.colors.info, label: "milestone" };
  }
  if (isPending(entry)) {
    return { color: theme.colors.warning, label: "needs input" };
  }
  return {
    color: theme.colors.secondary,
    label: entry.input?.status === "cancelled" ? "cancelled" : "answered",
  };
}

/**
 * The kind, then details. Each detail is its own flex item in a wrapping row,
 * so a narrow panel moves whole details to the next line instead of cutting
 * them off or splitting "Sep 21 09:12" apart.
 */
export function FeedMetaLine({
  entry,
  details,
}: {
  readonly entry: KindEntry;
  readonly details: readonly (string | undefined)[];
}) {
  const { color, label } = kindStyle(entry);
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
      <text fg={color} flexShrink={0} wrapMode="none">
        {isPending(entry) ? <strong>{label}</strong> : label}
      </text>
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
