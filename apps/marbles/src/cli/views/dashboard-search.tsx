import { RunFilterNotice, SearchBar } from "~/components/blocks/search-bar";
import { describeFilter } from "../state/dashboard-rows";
import type { DashboardState } from "../state/dashboard-state";
import type { Dashboard } from "../state/use-dashboard";

export function browsing(state: DashboardState): boolean {
  return (
    (state.view === "overview" || state.view === "catalog") &&
    state.drawer === undefined &&
    state.picker === undefined
  );
}

export function BrowseSearch({
  dashboard,
}: {
  readonly dashboard: Pick<
    Dashboard,
    "finishSearch" | "pane" | "quit" | "setQuery" | "snapshot" | "state"
  >;
}) {
  const { pane, snapshot, state } = dashboard;
  const filter = describeFilter(snapshot, state.filter);
  return (
    <>
      {filter && <RunFilterNotice label={filter} />}
      <SearchBar
        editing={state.searching}
        focused={!dashboard.quit.quitting}
        onInput={dashboard.setQuery}
        onSubmit={dashboard.finishSearch}
        query={pane === "details" ? "" : state.queries[pane]}
        scope={pane}
      />
    </>
  );
}
