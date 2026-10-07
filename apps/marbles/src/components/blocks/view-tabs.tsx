import { useCallback } from "react";
import { CountBadge } from "~/components/ui/count-badge";
import { theme } from "~/components/ui/theme";
import type { DashboardViewKey } from "~/views/dashboard-state";

function ViewTab({
  view,
  label,
  count,
  active,
  onChange,
}: {
  readonly view: DashboardViewKey;
  readonly label: string;
  readonly count: number;
  readonly active: boolean;
  readonly onChange: (view: DashboardViewKey) => void;
}) {
  const press = useCallback(() => onChange(view), [onChange, view]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Terminal tab; Shift+D and Shift+F are its keyboard equivalents.
    <box
      flexDirection="row"
      flexShrink={0}
      gap={1}
      id={`view:${view}`}
      onMouseDown={press}
    >
      <text fg={active ? theme.colors.primary : theme.colors.mutedForeground}>
        {active ? <strong>{label}</strong> : label}
      </text>
      <CountBadge active={active} count={count} />
    </box>
  );
}

/** Top-level tabs with their totals, so either shows at a glance whether it has something. */
export function ViewTabs({
  view,
  runCount,
  feedCount,
  onChange,
}: {
  readonly view: DashboardViewKey;
  readonly runCount: number;
  readonly feedCount: number;
  readonly onChange: (view: DashboardViewKey) => void;
}) {
  return (
    <box flexDirection="row" flexShrink={0} gap={3} height={1}>
      <ViewTab
        active={view === "dashboard"}
        count={runCount}
        label="Dashboard"
        onChange={onChange}
        view="dashboard"
      />
      <ViewTab
        active={view === "feed"}
        count={feedCount}
        label="Feed"
        onChange={onChange}
        view="feed"
      />
      <text fg={theme.colors.mutedForeground} flexGrow={1} wrapMode="none">
        Shift+D / Shift+F
      </text>
    </box>
  );
}
