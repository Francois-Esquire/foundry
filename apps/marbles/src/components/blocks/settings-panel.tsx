import { Action } from "~/components/ui/action";
import { Panel } from "~/components/ui/panel";
import { SelectableRow } from "~/components/ui/selectable-row";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";
import type { SettingsSnapshot, ThemeName } from "~/model/settings";

export interface ThemeChoice {
  readonly label: string;
  readonly name: ThemeName;
  readonly swatches: {
    readonly accent: string;
    readonly background: string;
    readonly primary: string;
  };
}

export interface SettingsView extends SettingsSnapshot {
  readonly label: string;
  readonly themes: readonly ThemeChoice[];
}

function ThemeChoices({
  current,
  themes,
  onTheme,
}: {
  readonly current: ThemeName;
  readonly themes: readonly ThemeChoice[];
  readonly onTheme: (name: ThemeName) => void;
}) {
  return themes.map(({ label, name, swatches }) => (
    <SelectableRow
      id={`theme:${name}`}
      key={name}
      onSelect={onTheme}
      selected={current === name}
      value={name}
    >
      <Text flexGrow={1} minWidth={0} truncate wrapMode="none">
        {label}
      </Text>
      <text flexShrink={0} wrapMode="none">
        <span bg={swatches.background}>{"  "}</span>
        <span bg={swatches.primary}>{"  "}</span>
        <span bg={swatches.accent}>{"  "}</span>
      </text>
    </SelectableRow>
  ));
}

export function SettingsBlock({
  settings,
  onTheme,
  onRail,
  rail,
}: {
  readonly settings?: SettingsView;
  readonly onTheme?: (name: ThemeName) => void;
  readonly onRail?: (show: boolean) => void;
  readonly rail?: boolean;
}) {
  const header = (
    <box flexDirection="column" gap={1} paddingBottom={1}>
      {settings ? (
        <>
          <box flexDirection="row" gap={1}>
            <Text>
              Theme: <strong>{settings.label}</strong>
            </Text>
            {!onTheme && (
              <text fg={theme.colors.mutedForeground}>read-only here</text>
            )}
          </box>
          {settings.problem && (
            <box flexDirection="column">
              <text fg={theme.colors.warning} wrapMode="word">
                {settings.problem}
              </text>
              <text fg={theme.colors.mutedForeground} wrapMode="word">
                {settings.path}
              </text>
            </box>
          )}
          <Text>Applies to all workspaces</Text>
          <box flexDirection="row" gap={1}>
            <Text>Preview</Text>
            <text fg={theme.colors.primary}>dreaming</text>
            <text fg={theme.colors.success}>complete</text>
          </box>
        </>
      ) : (
        <Text>This host has no settings to change.</Text>
      )}
      {onRail && (
        <box flexDirection="column">
          <Text>Workspace navigation · this terminal</Text>
          <box flexDirection="row" gap={2}>
            <Action
              active={!rail}
              label="Picker"
              onAction={onRail}
              value={false}
            />
            <Action
              active={rail}
              label="Rail (wide terminals)"
              onAction={onRail}
              value={true}
            />
          </box>
        </box>
      )}
    </box>
  );

  return (
    <Panel
      active
      header={header}
      id="panel:settings"
      selectedId={settings && onTheme ? `theme:${settings.theme}` : undefined}
      title="Settings"
    >
      {settings && onTheme && (
        <ThemeChoices
          current={settings.theme}
          onTheme={onTheme}
          themes={settings.themes}
        />
      )}
    </Panel>
  );
}
