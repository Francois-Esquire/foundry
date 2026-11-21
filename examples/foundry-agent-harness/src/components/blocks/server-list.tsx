import { Hint } from "@/components/blocks/hint";
import { ListRow } from "@/components/blocks/list-row";
import { useTheme } from "@/hooks/use-theme";
import type { Server } from "@/model/context";

export function ServerList({
  servers,
}: {
  readonly servers: readonly Server[];
}) {
  const theme = useTheme();
  if (servers.length === 0) {
    return <Hint>No MCP servers added by the harness.</Hint>;
  }
  return (
    <>
      {servers.map((server) => (
        <box flexDirection="column" key={server.name}>
          <ListRow
            color={theme.colors.foreground}
            icon="◆"
            note={server.description}
          >
            {server.name}
          </ListRow>
          {server.tools.map((tool) => (
            <box key={tool.name} paddingLeft={2}>
              <ListRow
                color={theme.colors.accent}
                icon="›"
                note={tool.description}
              >
                {tool.name}
              </ListRow>
            </box>
          ))}
        </box>
      ))}
      <box marginTop={1}>
        <Hint>
          Added by the harness. Connectors on your Claude account load too.
        </Hint>
      </box>
    </>
  );
}
