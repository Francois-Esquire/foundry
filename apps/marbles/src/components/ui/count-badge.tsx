import { useTheme } from "~/hooks/use-theme";

const MAX_COUNT = 99;

export function formatCount(count: number): string {
  return count > MAX_COUNT ? `${MAX_COUNT}+` : String(count);
}

/** A one-line pill for tab labels; it takes the tab's color when active. */
export function CountBadge({
  count,
  active = false,
}: {
  readonly count: number;
  readonly active?: boolean;
}) {
  const theme = useTheme();
  return (
    <text
      bg={active ? theme.colors.primary : theme.colors.muted}
      fg={active ? theme.colors.primaryForeground : theme.colors.foreground}
      wrapMode="none"
    >
      {` ${formatCount(count)} `}
    </text>
  );
}
