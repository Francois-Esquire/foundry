import { useCallback } from "react";
import type { DashboardViewKey } from "~/cli/state/dashboard-state";
import { theme } from "~/components/ui/theme";

function ViewTab({
  view,
  label,
  active,
  onChange,
}: {
  readonly view: DashboardViewKey;
  readonly label: string;
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
    </box>
  );
}

export function ViewTabs({
  view,
  onChange,
}: {
  readonly view: DashboardViewKey;
  readonly onChange: (view: DashboardViewKey) => void;
}) {
  const tabs = [
    { label: "Dashboard", view: "overview" },
    { label: "Catalog", view: "catalog" },
    { label: "Feed", view: "feed" },
  ] as const;
  return (
    <box flexDirection="row" flexShrink={0} gap={3} height={1}>
      {tabs.map((tab) => (
        <ViewTab
          active={view === tab.view}
          key={tab.view}
          label={tab.label}
          onChange={onChange}
          view={tab.view}
        />
      ))}
    </box>
  );
}
