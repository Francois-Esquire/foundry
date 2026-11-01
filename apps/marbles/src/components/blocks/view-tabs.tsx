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
  readonly count?: number;
  readonly active: boolean;
  readonly onChange: (view: DashboardViewKey) => void;
}) {
  const press = useCallback(() => onChange(view), [onChange, view]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Terminal tab; Shift and its letter is the keyboard equivalent.
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
      {count !== undefined && <CountBadge active={active} count={count} />}
    </box>
  );
}

/** Top-level tabs with their totals, so each shows at a glance whether it has something. */
export function ViewTabs({
  view,
  counts,
  onChange,
}: {
  readonly view: DashboardViewKey;
  readonly counts: Readonly<
    Record<Exclude<DashboardViewKey, "settings">, number>
  >;
  readonly onChange: (view: DashboardViewKey) => void;
}) {
  const tabs = [
    { count: counts.overview, label: "Overview", view: "overview" },
    { count: counts.catalog, label: "Catalog", view: "catalog" },
    { count: counts.logs, label: "Logs", view: "logs" },
    { count: counts.feed, label: "Feed", view: "feed" },
    { label: "Settings", view: "settings" },
  ] as const;
  return (
    <box flexDirection="row" flexShrink={0} gap={3} height={1}>
      {tabs.map((tab) => (
        <ViewTab
          active={view === tab.view}
          count={"count" in tab ? tab.count : undefined}
          key={tab.view}
          label={tab.label}
          onChange={onChange}
          view={tab.view}
        />
      ))}
      <text fg={theme.colors.mutedForeground} flexGrow={1} wrapMode="none">
        Shift+D/C/L/F/S
      </text>
    </box>
  );
}
