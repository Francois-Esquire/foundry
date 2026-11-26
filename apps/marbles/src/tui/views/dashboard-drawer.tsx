import { LogsBlock } from "~/components/blocks/logs-panel";
import { SearchBar } from "~/components/blocks/search-bar";
import { SettingsBlock } from "~/components/blocks/settings-panel";
import { WorkspacesPanel } from "~/components/blocks/workspaces-panel";
import { Text } from "~/components/ui/text";
import type { DrawerContent } from "../state/dashboard-views";

export function DashboardDrawer({
  drawer,
}: {
  readonly drawer: DrawerContent;
}) {
  switch (drawer.kind) {
    case "workspaces":
      return <WorkspacesPanel {...drawer.workspaces} />;
    case "settings":
      return <SettingsBlock {...drawer.settings} />;
    default:
      return (
        <>
          <SearchBar {...drawer.search} />
          {drawer.runId && <Text>Run {drawer.runId} · x clear</Text>}
          <LogsBlock {...drawer.logs} />
        </>
      );
  }
}
