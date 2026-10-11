import { useCallback, useMemo } from "react";
import { type BelongingRegion, fileDistricts } from "../belonging";
import { placementKey } from "../codex/resolve";
import type { CodexPlacement } from "../codex/vocabulary";
import { folderWithin } from "../folder-sectors";
import { featureText, importCounts } from "../natural-feature-inspection";
import type { NaturalFeatures } from "../natural-features";
import { tieCount } from "../proximity";
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
import {
  domainLabelText,
  domainsText,
  islandNestingText,
  pathRegionText,
} from "./nesting-domain-text";
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
  const districts = useMemo(
    () => fileDistricts(regions, composites),
    [regions, composites]
  );
  const handleClear = useCallback(() => onSelect(null), [onSelect]);
  const handleFrame = useCallback(() => {
    if (place) {
      onFrame(place.members.map((file) => file.id));
    }
  }, [onFrame, place]);
  const pointer = describePointer(hoveredWreck, hover, hoveredRegion, data, {
    districts,
    features,
  });
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
        {describeSelection(
          selection,
          place,
          region,
          territory,
          composites,
          data,
          districts
        )}
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
            districtId={selection.regionId}
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

/** What Place reads of the atlas beyond the selection: layers, and where each place is used. */
type AtlasFacts = Pick<
  AtlasData,
  | "domains"
  | "nesting"
  | "packageLayers"
  | "placement"
  | "proximity"
  | "territories"
>;

/** A file's name, with its package's when it lives in another: "b.ts", or "b.ts in marbles". */
function fileName(atlas: AtlasFacts, path: string, territory: Territory) {
  const name = path.split("/").at(-1) ?? path;
  const owner = atlas.territories.find((item) =>
    item.files.some((file) => file.path === path)
  );
  return owner && owner !== territory ? `${name} in ${owner.label}` : name;
}

/**
 * What the `proximity` lens says of a file, as Place reads it: "proximity:
 * apart from its responsibility's folder lib · 2 steps; changes with b.ts ·
 * 6 commits, no import path, and 2 more; its folder holds 3 unrelated
 * groups"; nothing when it says nothing, or when the package has no
 * internals.
 */
function proximityText(
  atlas: AtlasFacts,
  file: AtlasFile,
  territory: Territory
): string | undefined {
  if (!atlas.proximity.labelled.includes(territory.id)) {
    return;
  }
  const said: string[] = [];
  const apart = atlas.proximity.apart.files.find(
    (entry) => entry.file === file.path
  );
  if (apart) {
    const folder =
      folderWithin(apart.responsibilityFolder, territory.folder) ||
      "the package folder";
    said.push(
      `apart from its responsibility's folder ${folder} · ${apart.distance} ${apart.distance === 1 ? "step" : "steps"}`
    );
  }
  const pairs = atlas.proximity.apart.coChanges
    .filter((pair) => pair.left === file.path || pair.right === file.path)
    .toSorted((a, b) => b.coChangeCommits - a.coChangeCommits);
  const [strongest] = pairs;
  if (strongest) {
    const other =
      strongest.left === file.path ? strongest.right : strongest.left;
    const imports = strongest.staticPath === "none" ? ", no import path" : "";
    const more = pairs.length > 1 ? `, and ${pairs.length - 1} more` : "";
    said.push(
      `changes with ${fileName(atlas, other, territory)} · ${strongest.coChangeCommits} commits${imports}${more}`
    );
  }
  const close = atlas.proximity.close.find(
    (folder) => folder.folder === file.directory
  );
  if (close) {
    said.push(
      `its folder holds ${close.groups.length} unrelated groups of responsibilities`
    );
  }
  return said.length ? `proximity: ${said.join("; ")}` : undefined;
}

/** What the `proximity` lens counts for a package: its close folders, apart files, and co-changes. */
function islandProximity(
  atlas: AtlasFacts,
  territory: Territory
): string | undefined {
  if (!atlas.proximity.labelled.includes(territory.id)) {
    return;
  }
  const close = atlas.proximity.close.filter(
    (folder) => folder.package === territory.id
  ).length;
  const apart = atlas.proximity.apart.files.filter(
    (entry) => entry.package === territory.id
  ).length;
  const files = new Set(territory.files.map((file) => file.path));
  const pairs = atlas.proximity.apart.coChanges.filter(
    (pair) => files.has(pair.left) || files.has(pair.right)
  ).length;
  const ties = tieCount(atlas, territory.id);
  return `proximity: ${close} close but unrelated, ${apart} apart, ${pairs} co-changing pairs · ${ties.drawn} of ${ties.all} ties drawn`;
}

/** What the two groupings say of a file, as Place reads them, and the shared shape of its readout. */
interface FileContext {
  /** Each file's district, by file id, once the island's belonging is read. */
  districts?: ReadonlyMap<string, BelongingRegion>;
  features?: NaturalFeatures;
}

/**
 * Where a place is used against where it lives, from the `placement` lens:
 * "placement: departs toward marbles · 7 of 9 consumer modules", "…: fits
 * · 4 of 5 consumer modules at home", "…: spread over 3 packages", or "…:
 * used by no other package"; nothing for a package whose use is unknown,
 * having no internals. Its own name leaves room for a domain's reading
 * beside it (4.2d).
 */
function placementText(
  atlas: AtlasFacts,
  place: Pick<CodexPlacement, "level" | "place">,
  packageId: string
): string | undefined {
  const reading = placementReading(atlas, place, packageId);
  if (!reading) {
    return;
  }
  // In a domain, a departure is told as two: the placement's, toward the
  // package, and the domain's, against the consumers' domains (4.2d).
  const key = placementKey(place);
  const domain = domainLabelText(atlas, key);
  if (domain && reading.startsWith("departs ")) {
    return `placement departure: ${reading.slice("departs ".length)} · ${domain}`;
  }
  return domain ? `placement: ${reading} · ${domain}` : `placement: ${reading}`;
}

function placementReading(
  atlas: AtlasFacts,
  place: Pick<CodexPlacement, "level" | "place">,
  packageId: string
): string | undefined {
  const placed = atlas.placement.places[placementKey(place)];
  if (!placed) {
    return atlas.placement.labelled.includes(packageId)
      ? "used by no other package"
      : undefined;
  }
  const consumers = placed.away.reduce(
    (sum, entry) => sum + entry.modules,
    placed.home
  );
  if (placed.label === "fits") {
    return `fits · ${placed.home} of ${consumers} consumer modules at home`;
  }
  const toward = placed.away.find((entry) => entry.package === placed.toward);
  if (placed.label === "departs" && toward) {
    const name =
      atlas.territories.find((item) => item.id === toward.package)?.label ??
      toward.package;
    return `departs toward ${name} · ${toward.modules} of ${consumers} consumer modules`;
  }
  const packages = placed.away.length + (placed.home ? 1 : 0);
  return `spread over ${packages} packages`;
}

/**
 * A file's kind; where it sits, its folder, and what it serves, its
 * district, once the island's belonging is read; where it is used, or its
 * symbol's when one is chosen; then its import counts. A summit file's
 * counts lead with its internal fan-in and its package's cutoff.
 */
function fileDetail(
  selection: Pick<AtlasSelection, "symbol" | "territory"> & {
    file: AtlasFile;
  },
  atlas: AtlasFacts,
  districts?: ReadonlyMap<string, BelongingRegion>
): string {
  const { file, symbol, territory } = selection;
  const folder = folderWithin(file.directory, territory.folder);
  const region = pathRegionText(atlas, file.directory);
  const where = `in ${folder || "the package folder"}${region ? `, ${region}` : ""}`;
  const district = districts?.get(file.id);
  const place = symbol
    ? { level: "symbol" as const, place: `${file.path}#${symbol.name}` }
    : { level: "file" as const, place: file.path };
  const inDomains = domainsText(atlas, place.place);
  const serves = [district && `district ${district.label}`, inDomains]
    .flatMap((text) => (text ? [` · ${text}`] : []))
    .join("");
  const use = placementText(atlas, place, territory.id);
  const near = proximityText(atlas, file, territory);
  const used = [use, near]
    .flatMap((text) => (text ? [` · ${text}`] : []))
    .join("");
  return `${file.kind} · ${where}${serves}${used} · ${importCounts(file, territory.highFanInCutoff)} It imports ${file.outgoing} ${file.outgoing === 1 ? "module" : "modules"}.`;
}

/** An island's dependency layer as a reader hears it: "Layer 2", or "No layer" where the graph could not place it. */
function layerName(
  layers: AtlasData["packageLayers"],
  territory: Territory
): string {
  const layer = layers[territory.id];
  return layer === null || layer === undefined ? "No layer" : `Layer ${layer}`;
}

/**
 * What places an island, as a reader hears it: its folder, which orders its
 * row, and its layer, which is the row; then where the package is used:
 * "apps/atlas · Layer 2 · used by no other package".
 */
function islandPlacement(atlas: AtlasFacts, territory: Territory): string {
  const layer = layerName(atlas.packageLayers, territory);
  const placed = territory.folder ? `${territory.folder} · ${layer}` : layer;
  const use = placementText(
    atlas,
    { level: "package", place: territory.folder },
    territory.id
  );
  const near = islandProximity(atlas, territory);
  const nested = islandNestingText(atlas, territory);
  const inDomains = domainsText(atlas, territory.folder);
  return [placed, use, nested, inDomains, near].filter(Boolean).join(" · ");
}

function describeSelection(
  selection: AtlasSelection,
  place: BelongingRegion | undefined,
  region: BelongingRegion | undefined,
  territory: Territory,
  composites: BelongingRegion[],
  atlas: AtlasFacts,
  districts: ReadonlyMap<string, BelongingRegion>
): string {
  const { file } = selection;
  if (file) {
    return fileDetail({ ...selection, file }, atlas, districts);
  }
  if (place) {
    return `${place.members.length} files · ${describePlaceKind(region, place)}`;
  }
  return `${territory.files.length} files · ${islandPlacement(atlas, territory)} · ${composites.filter((item) => !item.collection).length} districts`;
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
  atlas: AtlasFacts,
  context: FileContext
) {
  const text = inspectionText(wreck, hover, region, atlas, context);
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
  atlas: AtlasFacts,
  { districts, features }: FileContext = {}
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
  const landmark = features?.landmarks.find(
    (item) => item.file.id === inspected.file?.id
  );
  if (landmark) {
    return featureText({ kind: "landmark", landmark });
  }
  if (inspected.feature) {
    return featureText(inspected.feature);
  }
  return {
    detail: inspectionDetail(inspected, region, atlas, districts),
    title: inspected.symbol
      ? `${inspected.symbol.name} · ${inspected.file?.path ?? inspected.territory.id}`
      : (inspected.file?.path ?? region?.label ?? inspected.territory.label),
  };
}

function inspectionDetail(
  inspected: AtlasSelection,
  region: BelongingRegion | undefined,
  atlas: AtlasFacts,
  districts?: ReadonlyMap<string, BelongingRegion>
): string {
  const { file } = inspected;
  if (file) {
    return fileDetail({ ...inspected, file }, atlas, districts);
  }
  if (region) {
    return `${region.members.length} files · ${region.children ? "Enter district" : "Enter responsibility"}`;
  }
  return `${inspected.territory.files.length} files · ${islandPlacement(atlas, inspected.territory)} · ${inspected.territory.analyzed ? "Select to explore" : "Not analyzed"}`;
}
