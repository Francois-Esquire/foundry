import { RunFilterNotice, SearchBar } from "~/components/blocks/search-bar";
import type { BrowseSearchModel } from "../state/dashboard-views";

export function BrowseSearch({
  search,
}: {
  readonly search: BrowseSearchModel;
}) {
  return (
    <>
      {search.filterLabel && <RunFilterNotice label={search.filterLabel} />}
      <SearchBar {...search.bar} />
    </>
  );
}
