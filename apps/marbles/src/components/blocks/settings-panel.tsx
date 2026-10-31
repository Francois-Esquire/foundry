import { KeyValue } from "~/components/ui/key-value";
import { Panel } from "~/components/ui/panel";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";
import { type SettingsSnapshot, THEME_NAMES } from "~/model/settings";

/** Global preferences, and what Marbles keeps locally about its own work. */
export function SettingsBlock({
  settings,
  editable,
}: {
  readonly settings?: SettingsSnapshot;
  readonly editable: boolean;
}) {
  return (
    <Panel active id="panel:settings" title="Settings · every workspace">
      {settings ? (
        <box flexDirection="column" gap={1}>
          <box flexDirection="row" gap={1} height={1}>
            <Text>Theme</Text>
            {THEME_NAMES.map((name) => (
              <text
                fg={
                  name === settings.theme
                    ? theme.colors.primary
                    : theme.colors.mutedForeground
                }
                key={name}
              >
                {name === settings.theme ? <strong>[{name}]</strong> : name}
              </text>
            ))}
            <text fg={theme.colors.mutedForeground}>
              {editable ? "←→ change" : "read-only here"}
            </text>
          </box>
          {settings.problem && (
            <text fg={theme.colors.warning}>{settings.problem}</text>
          )}
          <KeyValue items={[{ key: "Saved in", value: settings.path }]} />
        </box>
      ) : (
        <Text>This host has no settings to change.</Text>
      )}
      <box flexDirection="column" marginTop={1}>
        <Text>
          <strong>Local diagnostics</strong>
        </Text>
        <Text>
          Run records, step logs, and each agent turn's tokens, duration and
          cost stay on this machine, under the state directory; Marbles' own
          status lines stay in memory while the workspace is hosted. Nothing is
          sent anywhere.
        </Text>
      </box>
    </Panel>
  );
}
