import { useCallback } from "react";
import type { BelongingRegion } from "../belonging";
import { featureText } from "../natural-feature-inspection";
import type { NaturalFeatures } from "../natural-features";
import type { ResponsibilityOverlay } from "../responsibility-focus";
import type { AtlasSelection } from "../scene/scene";
import type { TradeRoute } from "../trade-routes";
import type {
  AtlasData,
  AtlasFile,
  AtlasSymbol,
  FormerPackage,
  Territory,
} from "../types";
import { ArchitecturePanel } from "./architecture-panel";
import { NaturalFeaturePanel } from "./natural-feature-panel";
import { TradePartners } from "./trade-partners";

export interface EvidenceActions {
  district: (id: string) => void;
  file: (file: AtlasFile, symbol?: AtlasSymbol) => void;
  frameDistrict: (ids: string[], districtId?: string) => void;
  layout: (territory: Territory | null) => void;
  overlay: (value: ResponsibilityOverlay | null) => void;
  unmappedModule: (module: string) => void;
}

/** Selected-place inspector with the pointer readout and architectural evidence. */
export function AtlasPlace({
  data,
  features,
  selection,
  hover,
  hoveredWreck,
  regions,
  composites,
  loading,
  error,
  onRetry,
  trades,
  tracing,
  evidenceOpen,
  evidence,
  onSelect,
  onFrame,
  onBrowse,
  onEvidence,
  onTrace,
}: {
  data: AtlasData;
  features?: NaturalFeatures;
  selection: AtlasSelection | null;
  hover: AtlasSelection | null;
  hoveredWreck: FormerPackage | null;
  regions: BelongingRegion[];
  composites: BelongingRegion[];
  loading: boolean;
  error?: string;
  onRetry: () => void;
  trades: TradeRoute[];
  tracing: boolean;
  evidenceOpen: boolean;
  evidence: EvidenceActions;
  onSelect: (value: AtlasSelection | null) => void;
  onFrame: (ids: string[]) => void;
  onBrowse: () => void;
  onEvidence: () => void;
  onTrace: () => void;
}) {
  const territory = selection?.territory;
  const region = regions.find((item) => item.id === selection?.regionId);
  const composite = composites.find(
    (item) => item.id === selection?.compositeId
  );
  const place = region ?? composite;
  const hoveredRegion = findRegion(regions, composites, hover);
  const handleClear = useCallback(() => onSelect(null), [onSelect]);
  const handleFrame = useCallback(() => {
    if (place) {
      onFrame(place.members.map((file) => file.id));
    }
  }, [onFrame, place]);
  const pointer = describePointer(hoveredWreck, hover, hoveredRegion, features);
  if (!(territory && selection)) {
    return (
      <div className="atlas-place">
        <h2>The archipelago</h2>
        <p>
          {data.territories.length} islands · Drag to explore · Scroll to move
          closer · Select a territory
        </p>
        {pointer}
      </div>
    );
  }
  return (
    <div className="atlas-place">
      <div className="atlas-place-heading">
        <h2>{placeTitle(selection, place, territory)}</h2>
        <button
          aria-label="Clear selection"
          className="atlas-place-close"
          onClick={handleClear}
          type="button"
        >
          Clear
        </button>
      </div>
      <p>
        {describeSelection(selection, place, region, territory, composites)}
      </p>
      {pointer}
      {loading && <p role="status">Reading belonging…</p>}
      {error && (
        <>
          <p role="alert">{error}</p>
          <button onClick={onRetry} type="button">
            Retry belonging
          </button>
        </>
      )}
      {features && (
        <NaturalFeaturePanel
          features={features}
          hover={hover}
          onSelect={onSelect}
          selection={selection}
        />
      )}
      <PlaceNote composite={composite} region={region} />
      {features && features.unrouted > 0 && (
        <details className="atlas-place-note">
          <summary>
            {features.unrouted} relationships have no mapped stream
          </summary>
          <p>
            All relationships remain in the evidence. Streams cannot cross water
            or another river to reach their consumer.
          </p>
          <ul>
            {features.omitted.map((item) => (
              <li key={`${item.from}:${item.to}`}>
                {regions.find((entry) => entry.id === item.from)?.label ??
                  item.from}{" "}
                imports from{" "}
                {regions.find((entry) => entry.id === item.to)?.label ??
                  item.to}
                : {item.moduleEdges} module edges.{" "}
                {
                  {
                    crossing: "No short route found clear of other rivers.",
                    endpoints: "No distinct mapped endpoints.",
                    land: "No continuous land route.",
                  }[item.reason]
                }
              </li>
            ))}
          </ul>
        </details>
      )}
      {!(place || selection.file) && (
        <TradePartners
          data={data}
          onSelect={onSelect}
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
        <button onClick={onBrowse} type="button">
          {browseLabel(region, composite)}
        </button>
        <button
          aria-controls="atlas-evidence"
          aria-expanded={evidenceOpen}
          onClick={onEvidence}
          type="button"
        >
          Evidence & alternatives
        </button>
        <button aria-pressed={tracing} onClick={onTrace} type="button">
          {tracing ? "Hide imports" : "Trace imports"}
        </button>
      </div>
      {(selection.file !== undefined || evidenceOpen) && (
        <section
          aria-label="Architectural evidence"
          className="atlas-evidence"
          hidden={!evidenceOpen}
          id="atlas-evidence"
        >
          <ArchitecturePanel
            districtId={selection.regionId ?? selection.neighborhoodId}
            file={selection.file}
            key={territory.id}
            onDistrict={evidence.district}
            onFile={evidence.file}
            onFrame={evidence.frameDistrict}
            onLayout={evidence.layout}
            onOverlay={evidence.overlay}
            onUnmappedModule={evidence.unmappedModule}
            survey={data.generatedAt}
            symbol={selection.symbol}
            territory={territory}
            unmappedModule={selection.unmappedModule}
          />
        </section>
      )}
    </div>
  );
}

function findRegion(
  regions: BelongingRegion[],
  composites: BelongingRegion[],
  value: AtlasSelection | null
): BelongingRegion | undefined {
  if (!value) {
    return undefined;
  }
  return (
    regions.find((region) => region.id === value.regionId) ??
    composites.find((region) => region.id === value.compositeId)
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

function placeTitle(
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

function browseLabel(
  region: BelongingRegion | undefined,
  composite: BelongingRegion | undefined
): string {
  if (region) {
    return "Browse members";
  }
  if (composite) {
    return "Browse responsibilities";
  }
  return "Browse districts";
}

function describeSelection(
  selection: AtlasSelection,
  place: BelongingRegion | undefined,
  region: BelongingRegion | undefined,
  territory: Territory,
  composites: BelongingRegion[]
): string {
  if (selection.file) {
    return `${selection.file.kind} · ${selection.file.incoming} incoming · ${selection.file.outgoing} outgoing`;
  }
  if (place) {
    return `${place.members.length} files · ${describePlaceKind(region, place)}`;
  }
  return `${territory.files.length} files · ${composites.filter((item) => !item.collection).length} districts`;
}

function describePlaceKind(
  region: BelongingRegion | undefined,
  place: BelongingRegion
): string {
  if (region) {
    return region.uncertain ? "Unresolved" : "Responsibility";
  }
  return `${place.children?.length ?? 0} responsibilities`;
}

/** Visible pointer readout; the shell keeps a matching polite live region. */
function describePointer(
  wreck: FormerPackage | null,
  hover: AtlasSelection | null,
  region: BelongingRegion | undefined,
  features?: NaturalFeatures
) {
  const text = inspectionText(wreck, hover, region, features);
  if (!text) {
    return null;
  }
  return (
    <p className="atlas-pointer">
      <strong>{text.title}</strong>
      <span>{text.detail}</span>
    </p>
  );
}

export function inspectionText(
  wreck: FormerPackage | null,
  inspected: AtlasSelection | null,
  region: BelongingRegion | undefined,
  features?: NaturalFeatures
): { title: string; detail: string } | null {
  if (wreck) {
    return {
      detail: `Former package · Last observed ${wreck.lastObserved.slice(0, 10)}`,
      title: wreck.id,
    };
  }
  if (!inspected) {
    return null;
  }
  const lake = features?.lakes.find(
    (item) => item.file.id === inspected.file?.id
  );
  if (lake) {
    return featureText({ kind: "lake", lake });
  }
  if (inspected.feature) {
    return featureText(inspected.feature);
  }
  return {
    detail: inspectionDetail(inspected, region),
    title: inspected.symbol
      ? `${inspected.symbol.name} · ${inspected.file?.path ?? inspected.territory.id}`
      : (inspected.file?.path ?? region?.label ?? inspected.territory.label),
  };
}

function inspectionDetail(
  inspected: AtlasSelection,
  region: BelongingRegion | undefined
): string {
  if (inspected.file) {
    return `${inspected.file.kind} · ${inspected.file.incoming} incoming imports · ${inspected.file.outgoing} outgoing imports`;
  }
  if (region) {
    return `${region.members.length} files · ${region.children ? "Enter district" : "Enter responsibility"}`;
  }
  return `${inspected.territory.files.length} files · ${inspected.territory.analyzed ? "Select to explore" : "Not analyzed"}`;
}
