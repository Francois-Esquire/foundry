import { Action } from "~/components/ui/action";
import { Panel } from "~/components/ui/panel";
import { SelectableRow } from "~/components/ui/selectable-row";
import { Text } from "~/components/ui/text";
import { terminalTheme, theme } from "~/components/ui/theme";
import {
  type SettingsSnapshot,
  THEME_NAMES,
  type ThemeName,
  themeLabel,
} from "~/model/settings";

function ThemeChoices({
  current,
  onTheme,
}: {
  readonly current: ThemeName;
  readonly onTheme: (name: ThemeName) => void;
}) {
  return THEME_NAMES.map((name) => {
    const { colors } = terminalTheme(name);
    return (
      <SelectableRow
        id={`theme:${name}`}
        key={name}
        onSelect={onTheme}
        selected={current === name}
        value={name}
      >
        <Text flexGrow={1} minWidth={0} truncate wrapMode="none">
          {themeLabel(name)}
        </Text>
        <text flexShrink={0} wrapMode="none">
          <span bg={colors.background}>{"  "}</span>
          <span bg={colors.primary}>{"  "}</span>
          <span bg={colors.accent}>{"  "}</span>
        </text>
      </SelectableRow>
    );
  });
}

export function SettingsBlock({
  settings,
  onTheme,
  onRail,
  rail,
}: {
  readonly settings?: SettingsSnapshot;
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
              Theme: <strong>{themeLabel(settings.theme)}</strong>
            </Text>
            {!onTheme && (
              <text fg={theme.colors.mutedForeground}>read-only here</text>
            )}
          </box>
          {settings.problem && (
            <text fg={theme.colors.warning} wrapMode="word">
              {settings.problem.replace(`${settings.path} `, "Settings file ")}
            </text>
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
        <ThemeChoices current={settings.theme} onTheme={onTheme} />
      )}
    </Panel>
  );
}
