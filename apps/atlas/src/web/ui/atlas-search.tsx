import type { ChangeEvent, MouseEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BelongingRegion } from "../belonging";
import type { AtlasSelection } from "../scene/scene";
import type { AtlasData, AtlasFile, Territory } from "../types";

/** Find a place: islands at overview, districts and files within an island. */
export function AtlasSearch({
  data,
  selection,
  regions,
  composites,
  onSelect,
}: {
  data: AtlasData;
  selection: AtlasSelection | null;
  regions: BelongingRegion[];
  composites: BelongingRegion[];
  onSelect: (value: AtlasSelection) => void;
}) {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const territory = selection?.territory;
  const region = regions.find((item) => item.id === selection?.regionId);
  const composite = composites.find(
    (item) => item.id === selection?.compositeId
  );
  useEffect(() => {
    input.current?.focus();
  }, []);
  const matches = (text: string) =>
    text.toLowerCase().includes(query.toLowerCase());
  const packages = data.territories.filter((item) => matches(item.label));
  const groups = (
    composite
      ? regions.filter((item) => composite.children?.includes(item.id))
      : composites
  ).filter((item) => matches(item.label));
  const files = (
    region?.members ?? typedFiles(query, composite, territory)
  ).filter((file) => matches(file.path));
  const handleQuery = useCallback(
    (event: ChangeEvent<HTMLInputElement, HTMLInputElement>) => {
      setQuery(event.target.value);
    },
    []
  );
  const chooseGroup = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const item = groups.find(
        (group) => group.id === event.currentTarget.value
      );
      if (!(territory && item)) {
        return;
      }
      onSelect(
        item.children
          ? { compositeId: item.id, territory }
          : {
              compositeId: composite?.id,
              regionId: item.id,
              territory,
            }
      );
    },
    [onSelect, composite, groups, territory]
  );
  const chooseFile = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const file = files.find((item) => item.id === event.currentTarget.value);
      if (territory && file) {
        onSelect({
          compositeId: composite?.id,
          file,
          regionId: region?.id,
          territory,
        });
      }
    },
    [onSelect, composite, files, region, territory]
  );
  const choosePackage = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const selected = data.territories.find(
        (item) => item.id === event.currentTarget.value
      );
      if (selected) {
        onSelect({ territory: selected });
      }
    },
    [onSelect, data]
  );
  return (
    <div className="atlas-search">
      <label className="atlas-search-field">
        <span className="sr-only">Search atlas</span>
        <input
          onChange={handleQuery}
          placeholder={territory ? "Find a region or file…" : "Find an island…"}
          ref={input}
          type="search"
          value={query}
        />
      </label>
      <nav aria-label="Search results" className="atlas-index">
        {territory ? (
          <PlaceEntries
            chooseFile={chooseFile}
            chooseGroup={chooseGroup}
            files={files}
            groups={groups}
            region={region}
          />
        ) : (
          packages.map((item) => (
            <button
              key={item.id}
              onClick={choosePackage}
              type="button"
              value={item.id}
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
    </div>
  );
}

function typedFiles(
  query: string,
  composite: BelongingRegion | undefined,
  territory: Territory | undefined
): AtlasFile[] {
  return query ? (composite?.members ?? territory?.files ?? []) : [];
}

function PlaceEntries({
  region,
  groups,
  chooseGroup,
  files,
  chooseFile,
}: {
  region: BelongingRegion | undefined;
  groups: BelongingRegion[];
  chooseGroup: (event: MouseEvent<HTMLButtonElement>) => void;
  files: AtlasFile[];
  chooseFile: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
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
  );
}
