import type { ChangeEvent } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ResponsibilityRelationship } from "../lib/internal-responsibility-types";
import { CompositionInspection } from "./composition-inspection";
import { districtLayout } from "./district-layout";
import type { AtlasInternals } from "./internals";
import { RelationshipInspection } from "./relationship-inspection";
import type { ResponsibilityOverlay } from "./responsibility-focus";
import type { AtlasFile, AtlasSymbol, Polygon, Territory } from "./types";
import { UnmappedModuleInspection } from "./unmapped-module-inspection";
import { useArchitecture } from "./use-architecture";

export function ArchitecturePanel({
  territory,
  file,
  survey,
  onOverlay,
  onFile,
  onFrame,
  onLayout,
  districtId,
  onDistrict,
  symbol,
  unmappedModule,
  onUnmappedModule,
}: {
  territory: Territory;
  file?: AtlasFile;
  survey: string;
  onOverlay: (value: ResponsibilityOverlay | null) => void;
  onFile: (file: AtlasFile, symbol?: AtlasSymbol) => void;
  symbol?: AtlasSymbol;
  unmappedModule?: string;
  onUnmappedModule: (module: string) => void;
  onFrame: (files: string[], districtId?: string) => void;
  onLayout: (territory: Territory | null) => void;
  districtId?: string;
  onDistrict: (id: string) => void;
}) {
  const [choice, setChoice] = useState<{ id: string; fileId?: string }>();
  const relationshipId = choice?.fileId === file?.id ? (choice?.id ?? "") : "";
  const { data, error, retry } = useArchitecture(territory.id, survey, true);
  const [districts, setDistricts] = useState(false);
  const layout = useMemo(
    () => (data && districts ? districtLayout(data, territory) : null),
    [data, districts, territory]
  );
  useEffect(() => {
    onLayout(layout?.territory ?? null);
    return () => {
      onLayout(null);
    };
  }, [layout, onLayout]);
  const module = Object.keys(data?.fileIds ?? {}).find(
    (id) => data?.fileIds[id] === file?.id
  );
  const relationship = data?.responsibilities.relationships.find(
    (item) => `${item.from}→${item.to}` === relationshipId
  );
  const district = data?.responsibilities.regions.find(
    (region) => region.id === districtId
  );
  const handleDistricts = useCallback(
    (event: ChangeEvent<HTMLInputElement, HTMLInputElement>) => {
      setDistricts(event.target.checked);
    },
    [setDistricts]
  );
  const handleDistrict = useCallback(
    (event: ChangeEvent<HTMLSelectElement, HTMLSelectElement>) => {
      if (!data) {
        return;
      }
      onDistrict(event.target.value);
      const region = data.responsibilities.regions.find(
        (item) => item.id === event.target.value
      );
      onFrame(
        region
          ? region.modules.flatMap((moduleId) => data.fileIds[moduleId] ?? [])
          : territory.files.map((atlasFile) => atlasFile.id),
        region?.id
      );
    },
    [data, onDistrict, onFrame, territory]
  );
  const handleChoice = useCallback(
    (event: ChangeEvent<HTMLSelectElement, HTMLSelectElement>) => {
      if (!data) {
        return;
      }
      setChoice(undefined);
      const next = territory.files.find(
        (value) => value.id === data.fileIds[event.target.value]
      );
      if (next) {
        onFile(next);
      } else {
        onUnmappedModule(event.target.value);
      }
    },
    [data, onFile, onUnmappedModule, setChoice, territory]
  );
  const handleUnmappedModule = useCallback(
    (event: ChangeEvent<HTMLSelectElement, HTMLSelectElement>) => {
      if (!data) {
        return;
      }
      if (unmappedModule) {
        onUnmappedModule("");
      }
      setChoice({ id: event.target.value });
      const selected = data.responsibilities.relationships.find(
        (item) => `${item.from}→${item.to}` === event.target.value
      );
      if (selected) {
        onFrame(
          data.responsibilities.regions
            .filter(
              (region) =>
                region.id === selected.from || region.id === selected.to
            )
            .flatMap((region) =>
              region.modules.flatMap(
                (moduleId2) => data.fileIds[moduleId2] ?? []
              )
            )
        );
      } else if (file) {
        onFile(file);
      }
    },
    [data, file, onFile, onFrame, onUnmappedModule, setChoice, unmappedModule]
  );
  const handleFile = useCallback(
    (symbolEntry: AtlasSymbol | undefined) => {
      if (file) {
        onFile(file, symbolEntry);
      }
    },
    [file, onFile]
  );
  if (error) {
    return (
      <>
        <p role="alert">{error}</p>
        <button onClick={retry} type="button">
          Retry composition
        </button>
      </>
    );
  }
  if (!data?.architecture) {
    return <p role="status">Reading symbol composition and alternatives…</p>;
  }
  return (
    <section aria-label="File composition">
      <details>
        <summary>Layout and map key</summary>
        <label>
          <input
            checked={districts}
            onChange={handleDistricts}
            type="checkbox"
          />{" "}
          Group files by responsibility
        </label>
        <p>
          Presentation only. Coastlines, source paths, and architectural
          ownership remain unchanged. Unassigned files retain their own
          identity.
        </p>
        {layout && (
          <p>
            {layout.territory.files.length} settlements fitted;{" "}
            {layout.unplaced.length} exceed this drawing's capacity. Unplaced
            files remain in the index, not at fabricated map positions.
          </p>
        )}
        {layout && (
          <p>
            Open circles: shared commons. Crossed squares: composition
            junctions. Paired marks: mixed scopes. Hollow squares: unclear
            scope. These describe roles, not quality.
          </p>
        )}
      </details>
      <label className="atlas-neighborhood-filter">
        <span>District</span>
        <select
          aria-label="District"
          onChange={handleDistrict}
          value={district?.id ?? ""}
        >
          <option value="">All districts and unassigned files</option>
          {data.responsibilities.regions.map((region) => (
            <option key={region.id} value={region.id}>
              {region.label} · {region.modules.length}
            </option>
          ))}
        </select>
      </label>
      <label className="atlas-neighborhood-filter">
        <span>Inspect a settlement</span>
        <select
          aria-label="Inspect a settlement"
          onChange={handleChoice}
          value={unmappedModule ?? module ?? ""}
        >
          <option value="">Choose a source module</option>
          {data.architecture.primitives.modules
            .filter(
              (item) => !district || district.modules.includes(item.module)
            )
            .map((item) => (
              <option key={item.module} value={item.module}>
                {item.module}
                {!data.fileIds[item.module] && " · not on map"}
              </option>
            ))}
        </select>
      </label>
      {file && layout?.unplaced.includes(file.id) && (
        <p>
          This file has no safe position in the district drawing. Its evidence
          remains available below.
        </p>
      )}
      <details>
        <summary>Trace a district relationship</summary>
        <label className="atlas-neighborhood-filter">
          <span>Relationship</span>
          <select
            aria-label="Relationship"
            onChange={handleUnmappedModule}
            value={relationshipId}
          >
            <option value="">File composition</option>
            {data.responsibilities.relationships.map((item) => (
              <option
                key={`${item.from}→${item.to}`}
                value={`${item.from}→${item.to}`}
              >
                {
                  data.responsibilities.regions.find(
                    (region) => region.id === item.from
                  )?.label
                }{" "}
                →{" "}
                {
                  data.responsibilities.regions.find(
                    (region) => region.id === item.to
                  )?.label
                }
              </option>
            ))}
          </select>
        </label>
      </details>
      {resolveArchitecturePanel(
        unmappedModule,
        data,
        onOverlay,
        relationship,
        relationshipId,
        module,
        file,
        layout,
        handleFile,
        symbol,
        territory
      )}
    </section>
  );
}

function resolveArchitecturePanel(
  unmappedModule: string | undefined,
  data: AtlasInternals,
  onOverlay: (value: ResponsibilityOverlay | null) => void,
  relationship: ResponsibilityRelationship | undefined,
  relationshipId: string,
  module: string | undefined,
  file: AtlasFile | undefined,
  layout: {
    territory: {
      files: AtlasFile[];
      neighborhoods: {
        id: string;
        imports: number;
        label: string;
        members: string[];
        sharedConcepts: number;
      }[];
      analyzed: boolean;
      coast: Polygon[];
      color: string;
      hills: Polygon[];
      id: string;
      label: string;
      radius: number;
      shallows: Polygon[];
      x: number;
      y: number;
    };
    unplaced: string[];
  } | null,
  handleFile: (symbolEntry: AtlasSymbol | undefined) => void,
  symbol: AtlasSymbol | undefined,
  territory: Territory
): React.ReactNode {
  if (unmappedModule) {
    return (
      <UnmappedModuleInspection
        data={data}
        module={unmappedModule}
        onOverlay={onOverlay}
      />
    );
  }
  if (relationship) {
    return (
      <RelationshipInspection
        data={data}
        from={relationship.from}
        key={relationshipId}
        onOverlay={onOverlay}
        to={relationship.to}
      />
    );
  }
  if (module && file) {
    return (
      <CompositionInspection
        data={data}
        file={
          layout?.territory.files.find((item) => item.id === file.id) ?? file
        }
        key={module}
        module={module}
        onOverlay={onOverlay}
        onSymbol={handleFile}
        symbol={symbol}
        territory={layout?.territory ?? territory}
      />
    );
  }
  return (
    <p>
      Select a file on the map or in this index. Detailed evidence stays local
      to that selection.
    </p>
  );
}
