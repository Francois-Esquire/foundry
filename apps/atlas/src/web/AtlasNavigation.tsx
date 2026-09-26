import { useEffect, useRef, useState } from "react";

import type { BelongingRegion } from "./belonging";
import type { AtlasSelection } from "./scene";
import { TradePartners } from "./TradePartners";
import type { TradeRoute } from "./trade-routes";
import type { AtlasData } from "./types";

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
  const choose = (value: AtlasSelection | null) => {
    onSelect(value);
    setSearchOpen(false);
    setQuery("");
    searchButton.current?.focus();
  };
  useEffect(() => {
    if (searchOpen) {
      input.current?.focus();
    }
  }, [searchOpen]);
  useEffect(() => {
    if (!searchOpen) {
      return;
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.stopImmediatePropagation();
      setSearchOpen(false);
      setQuery("");
      searchButton.current?.focus();
    };
    window.addEventListener("keydown", escape, true);
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
      window.removeEventListener("keydown", escape, true);
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
    region?.members ??
    (query ? (composite?.members ?? territory?.files ?? []) : [])
  ).filter((file) => matches(file.path));
  return (
    <>
      <header className="atlas-navigation">
        <nav aria-label="Atlas breadcrumb" className="atlas-breadcrumb">
          <button
            onClick={() => {
              choose(null);
            }}
          >
            Atlas
          </button>
          {territory && (
            <>
              <span aria-hidden="true">/</span>
              <button
                onClick={() => {
                  choose({ territory });
                }}
              >
                {territory.label}
              </button>
            </>
          )}
          {composite && (
            <>
              <span aria-hidden="true">/</span>
              <button
                onClick={() => {
                  if (territory) {
                    choose({ compositeId: composite.id, territory });
                  }
                }}
              >
                {composite.label}
              </button>
            </>
          )}
          {region && (
            <>
              <span aria-hidden="true">/</span>
              <button
                onClick={() => {
                  if (territory) {
                    choose({
                      compositeId: composite?.id,
                      regionId: region.id,
                      territory,
                    });
                  }
                }}
              >
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
            <select
              aria-label="Map layer"
              onChange={(event) => {
                onLens(event.target.value as "belonging" | "files");
              }}
              value={lens}
            >
              <option value="belonging">Belonging</option>
              <option value="files">Files</option>
            </select>
          </label>
          <button
            aria-controls="atlas-search-drawer"
            aria-expanded={searchOpen}
            onClick={() => {
              setSearchOpen(!searchOpen);
              if (searchOpen) {
                setQuery("");
              }
            }}
            ref={searchButton}
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
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              placeholder={
                territory ? "Find a region or file…" : "Find an island…"
              }
              ref={input}
              type="search"
              value={query}
            />
          </label>
          <nav aria-label="Search results" className="atlas-index">
            {territory ? (
              <>
                {!region &&
                  groups.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => {
                        choose(
                          item.children
                            ? { compositeId: item.id, territory }
                            : {
                                compositeId: composite?.id,
                                regionId: item.id,
                                territory,
                              }
                        );
                      }}
                    >
                      <span
                        className="atlas-swatch"
                        style={{ background: item.color }}
                      />
                      <span>{item.label}</span>
                      <small>{item.members.length}</small>
                    </button>
                  ))}
                {files.map((file) => (
                  <button
                    key={file.id}
                    onClick={() => {
                      choose({
                        compositeId: composite?.id,
                        file,
                        regionId: region?.id,
                        territory,
                      });
                    }}
                    title={file.path}
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
                  onClick={() => {
                    choose({ territory: item });
                  }}
                >
                  <span
                    className="atlas-swatch"
                    style={{ background: item.color }}
                  />
                  <span>{item.label}</span>
                  <small>{item.files.length}</small>
                </button>
              ))
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
            onClick={() => {
              onSelect(null);
            }}
          >
            Close
          </button>
          <h2>
            {selection.symbol?.name ??
              selection.file?.path.split("/").at(-1) ??
              place?.label ??
              territory.label}
          </h2>
          <p>
            {selection.file
              ? `${selection.file.kind} · ${selection.file.incoming} incoming · ${selection.file.outgoing} outgoing`
              : place
                ? `${place.members.length} files · ${region ? (region.uncertain ? "Unresolved" : "Responsibility") : `${place.children?.length ?? 0} responsibilities`}`
                : `${territory.files.length} files · ${composites.filter((item) => !item.collection).length} districts`}
          </p>
          {loading && <p role="status">Reading belonging…</p>}
          {error && (
            <>
              <p role="alert">{error}</p>
              <button onClick={onRetry}>Retry belonging</button>
            </>
          )}
          {region && (
            <p className="atlas-place-note">
              {region.uncertain
                ? "Broken edges mark uncertainty, not an assigned district."
                : "Colored marks are members. Nearby files may belong elsewhere."}
            </p>
          )}
          {composite && !region && (
            <p className="atlas-place-note">
              {composite.collection
                ? "Kept accessible without inventing a shared district."
                : `${composite.label} anchors this district. ${composite.anchorReason}.`}
            </p>
          )}
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
              <button
                onClick={() => {
                  onFrame(place.members.map((file) => file.id));
                }}
              >
                Frame members
              </button>
            )}
            <button
              onClick={() => {
                setSearchOpen(true);
              }}
            >
              {region
                ? "Browse members"
                : composite
                  ? "Browse responsibilities"
                  : "Browse districts"}
            </button>
            <button onClick={onEvidence}>Evidence & alternatives</button>
            <button aria-pressed={tracing} onClick={onTrace}>
              {tracing ? "Hide imports" : "Trace imports"}
            </button>
          </div>
        </section>
      )}
    </>
  );
}
