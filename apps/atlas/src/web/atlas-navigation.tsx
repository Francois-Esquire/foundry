import type { ChangeEvent, MouseEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BelongingRegion } from "./belonging";
import type { AtlasSelection } from "./scene";
import { TradePartners } from "./trade-partners";
import type { TradeRoute } from "./trade-routes";
import type { AtlasData, AtlasFile, Territory } from "./types";

function selectedPlaceTitle(
  selection: AtlasSelection,
  place: BelongingRegion | undefined,
  territory: Territory
): string {
  return (
    selection.symbol?.name ??
    selection.file?.path.split("/").at(-1) ??
    place?.label ??
    territory.label
  );
}

function PlaceNote({
  region,
  composite,
}: {
  region: BelongingRegion | undefined;
  composite: BelongingRegion | undefined;
}) {
  if (region) {
    return (
      <p className="atlas-place-note">
        {region.uncertain
          ? "Broken edges mark uncertainty, not an assigned district."
          : "Colored marks are members. Nearby files may belong elsewhere."}
      </p>
    );
  }
  if (composite) {
    return (
      <p className="atlas-place-note">
        {composite.collection
          ? "Kept accessible without inventing a shared district."
          : `${composite.label} anchors this district. ${composite.anchorReason}.`}
      </p>
    );
  }
  return null;
}

export function AtlasNavigation({
  data,
  selection,
  regions,
  composites,
  lens,
  onLens,
  onSelect,
  onFrame,
  onEvidence,
  loading,
  error,
  onRetry,
  onTrace,
  tracing,
  trades,
}: {
  data: AtlasData;
  selection: AtlasSelection | null;
  regions: BelongingRegion[];
  composites: BelongingRegion[];
  lens: "belonging" | "files";
  onLens: (lens: "belonging" | "files") => void;
  onSelect: (value: AtlasSelection | null) => void;
  onFrame: (ids: string[]) => void;
  onEvidence: () => void;
  loading: boolean;
  error?: string;
  onRetry: () => void;
  onTrace: () => void;
  tracing: boolean;
  trades: TradeRoute[];
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const territory = selection?.territory;
  const region = regions.find((item) => item.id === selection?.regionId);
  const composite = composites.find(
    (item) => item.id === selection?.compositeId
  );
  const place = region ?? composite;
  const choose = useCallback(
    (value: AtlasSelection | null) => {
      onSelect(value);
      setSearchOpen(false);
      setQuery("");
      searchButton.current?.focus();
    },
    [onSelect, searchButton, setQuery, setSearchOpen]
  );
  useEffect(() => {
    if (searchOpen) {
      input.current?.focus();
    }
  }, [searchOpen]);
  useEffect(() => {
    if (!searchOpen) {
      return;
    }
    const currentEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.stopImmediatePropagation();
      setSearchOpen(false);
      setQuery("");
      searchButton.current?.focus();
    };
    window.addEventListener("keydown", currentEscape, true);
    const outside = (event: PointerEvent) => {
      if (
        !(event.target instanceof Element) ||
        event.target.closest(".atlas-search-drawer") ||
        searchButton.current?.contains(event.target)
      ) {
        return;
      }
      setSearchOpen(false);
      setQuery("");
    };
    window.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("keydown", currentEscape, true);
      window.removeEventListener("pointerdown", outside);
    };
  }, [searchOpen]);
  const matches = (text: string) =>
    text.toLowerCase().includes(query.toLowerCase());
  const packages = data.territories.filter((item) => matches(item.label));
  const groups = (
    composite
      ? regions.filter((item) => composite.children?.includes(item.id))
      : composites
  ).filter((item) => matches(item.label));
  const files = (
    region?.members ?? AtlasNavigationEntries2(query, composite, territory)
  ).filter((file) => matches(file.path));
  const handleClick = useCallback(() => {
    choose(null);
  }, [choose]);
  const handleClick2 = useCallback(() => {
    if (!territory) {
      return;
    }
    choose({ territory });
  }, [choose, territory]);
  const handleClick3 = useCallback(() => {
    if (territory && composite) {
      choose({ compositeId: composite.id, territory });
    }
  }, [choose, composite, territory]);
  const handleClick4 = useCallback(() => {
    if (territory && region) {
      choose({
        compositeId: composite?.id,
        regionId: region.id,
        territory,
      });
    }
  }, [choose, composite, region, territory]);
  const handleLens = useCallback(
    (event: ChangeEvent<HTMLSelectElement, HTMLSelectElement>) => {
      onLens(event.target.value as "belonging" | "files");
    },
    [onLens]
  );
  const handleSearchOpen = useCallback(() => {
    setSearchOpen(!searchOpen);
    if (searchOpen) {
      setQuery("");
    }
  }, [searchOpen, setQuery, setSearchOpen]);
  const handleQuery = useCallback(
    (event: ChangeEvent<HTMLInputElement, HTMLInputElement>) => {
      setQuery(event.target.value);
    },
    [setQuery]
  );
  const handleSelect = useCallback(() => {
    onSelect(null);
  }, [onSelect]);
  const handleFrame = useCallback(() => {
    if (place) {
      onFrame(place.members.map((file) => file.id));
    }
  }, [onFrame, place]);
  const handleSearchOpen2 = useCallback(() => {
    setSearchOpen(true);
  }, [setSearchOpen]);
  const chooseGroup = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const item = groups.find(
        (group) => group.id === event.currentTarget.value
      );
      if (!(territory && item)) {
        return;
      }
      choose(
        item.children
          ? { compositeId: item.id, territory }
          : {
              compositeId: composite?.id,
              regionId: item.id,
              territory,
            }
      );
    },
    [choose, composite, groups, territory]
  );
  const chooseFile = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const file = files.find((item) => item.id === event.currentTarget.value);
      if (territory && file) {
        choose({
          compositeId: composite?.id,
          file,
          regionId: region?.id,
          territory,
        });
      }
    },
    [choose, composite, files, region, territory]
  );
  const choosePackage = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const selected = data.territories.find(
        (item) => item.id === event.currentTarget.value
      );
      if (selected) {
        choose({ territory: selected });
      }
    },
    [choose, data]
  );
  return (
    <>
      <header className="atlas-navigation">
        <nav aria-label="Atlas breadcrumb" className="atlas-breadcrumb">
          <button onClick={handleClick} type="button">
            Atlas
          </button>
          {territory && (
            <>
              <span aria-hidden="true">/</span>
              <button onClick={handleClick2} type="button">
                {territory.label}
              </button>
            </>
          )}
          {composite && (
            <>
              <span aria-hidden="true">/</span>
              <button onClick={handleClick3} type="button">
                {composite.label}
              </button>
            </>
          )}
          {region && (
            <>
              <span aria-hidden="true">/</span>
              <button onClick={handleClick4} type="button">
                {region.label}
              </button>
            </>
          )}
          {selection?.file && (
            <>
              <span aria-hidden="true">/</span>
              <span aria-current="location">
                {selection.file.path.split("/").at(-1)}
              </span>
            </>
          )}
        </nav>
        <div className="atlas-navigation-tools">
          <label>
            <span className="sr-only">Map layer</span>
            <select aria-label="Map layer" onChange={handleLens} value={lens}>
              <option value="belonging">Belonging</option>
              <option value="files">Files</option>
            </select>
          </label>
          <button
            aria-controls="atlas-search-drawer"
            aria-expanded={searchOpen}
            onClick={handleSearchOpen}
            ref={searchButton}
            type="button"
          >
            Find a place
          </button>
        </div>
      </header>
      {searchOpen && (
        <section
          aria-label="Find a place"
          className="atlas-search-drawer"
          id="atlas-search-drawer"
          role="dialog"
        >
          <label className="atlas-search">
            <span className="sr-only">Search atlas</span>
            <input
              onChange={handleQuery}
              placeholder={
                territory ? "Find a region or file…" : "Find an island…"
              }
              ref={input}
              type="search"
              value={query}
            />
          </label>
          <nav aria-label="Search results" className="atlas-index">
            {AtlasNavigationEntries(
              territory,
              region,
              groups,
              chooseGroup,
              files,
              chooseFile,
              packages,
              choosePackage
            )}
            {!(territory || packages.length) && <p>No matching islands.</p>}
          </nav>
        </section>
      )}
      {territory && (
        <section aria-label="Selected place" className="atlas-place">
          <button
            aria-label="Clear selection"
            className="atlas-place-close"
            onClick={handleSelect}
            type="button"
          >
            Close
          </button>
          <h2>{selectedPlaceTitle(selection, place, territory)}</h2>
          <p>
            {resolveAtlasNavigation(
              selection,
              place,
              region,
              territory,
              composites
            )}
          </p>
          {loading && <p role="status">Reading belonging…</p>}
          {error && (
            <>
              <p role="alert">{error}</p>
              <button onClick={onRetry} type="button">
                Retry belonging
              </button>
            </>
          )}
          <PlaceNote composite={composite} region={region} />
          {!(place || selection.file) && (
            <TradePartners
              data={data}
              onSelect={choose}
              routes={trades}
              territory={territory}
            />
          )}
          <div className="atlas-place-actions">
            {place && (
              <button onClick={handleFrame} type="button">
                Frame members
              </button>
            )}
            <button onClick={handleSearchOpen2} type="button">
              {resolveAtlasNavigation2(region, composite)}
            </button>
            <button onClick={onEvidence} type="button">
              Evidence & alternatives
            </button>
            <button aria-pressed={tracing} onClick={onTrace} type="button">
              {tracing ? "Hide imports" : "Trace imports"}
            </button>
          </div>
        </section>
      )}
    </>
  );
}

function AtlasNavigationEntries2(
  query: string,
  composite: BelongingRegion | undefined,
  territory: Territory | undefined
): AtlasFile[] {
  return query ? (composite?.members ?? territory?.files ?? []) : [];
}

function AtlasNavigationEntries(
  territory: Territory | undefined,
  region: BelongingRegion | undefined,
  groups: BelongingRegion[],
  chooseGroup: (event: MouseEvent<HTMLButtonElement>) => void,
  files: AtlasFile[],
  chooseFile: (event: MouseEvent<HTMLButtonElement>) => void,
  packages: Territory[],
  choosePackage: (event: MouseEvent<HTMLButtonElement>) => void
): React.ReactNode {
  return territory ? (
    <>
      {!region &&
        groups.map((item) => (
          <button
            key={item.id}
            onClick={chooseGroup}
            type="button"
            value={item.id}
          >
            <span className="atlas-swatch" style={{ background: item.color }} />
            <span>{item.label}</span>
            <small>{item.members.length}</small>
          </button>
        ))}
      {files.map((file) => (
        <button
          key={file.id}
          onClick={chooseFile}
          title={file.path}
          type="button"
          value={file.id}
        >
          <span className="atlas-file-name">
            {file.path.split("/").slice(2).join("/") || file.path}
          </span>
        </button>
      ))}
      {!files.length && (!groups.length || region) && (
        <p>No matching places.</p>
      )}
    </>
  ) : (
    packages.map((item) => (
      <button
        key={item.id}
        onClick={choosePackage}
        type="button"
        value={item.id}
      >
        <span className="atlas-swatch" style={{ background: item.color }} />
        <span>{item.label}</span>
        <small>{item.files.length}</small>
      </button>
    ))
  );
}

function resolveAtlasNavigation2(
  region: BelongingRegion | undefined,
  composite: BelongingRegion | undefined
): React.ReactNode {
  if (region) {
    return "Browse members";
  }
  if (composite) {
    return "Browse responsibilities";
  }
  return "Browse districts";
}

function resolveAtlasNavigation(
  selection: AtlasSelection,
  place: BelongingRegion | undefined,
  region: BelongingRegion | undefined,
  territory: Territory,
  composites: BelongingRegion[]
): React.ReactNode {
  if (selection.file) {
    return `${selection.file.kind} · ${selection.file.incoming} incoming · ${selection.file.outgoing} outgoing`;
  }
  if (place) {
    return `${place.members.length} files · ${resolveResolveAtlasNavigation(region, place)}`;
  }
  return `${territory.files.length} files · ${composites.filter((item) => !item.collection).length} districts`;
}

function resolveResolveAtlasNavigation(
  region: BelongingRegion | undefined,
  place: BelongingRegion
): string {
  if (region) {
    if (region.uncertain) {
      return "Unresolved";
    }
    return "Responsibility";
  }
  return `${place.children?.length ?? 0} responsibilities`;
}
