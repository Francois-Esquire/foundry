import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArchitecturePanel } from "./architecture-panel";
import { AtlasNavigation } from "./atlas-navigation";
import type { BelongingLayer } from "./belonging";
import { type BelongingRegion, belongingAncestry } from "./belonging";
import type { BoundaryVisibility } from "./boundaries";
import { chartFilters, defaultChartSettings } from "./chart-settings";
import { ChartSettingsPanel } from "./chart-settings-panel";
import type { AtlasInternals } from "./internals";
import { defaultLandmassSettings, relayoutAtlas } from "./landmasses";
import type { PlaybackSnapshot } from "./playback";
import { trackIds } from "./playback";
import type { ResponsibilityOverlay } from "./responsibility-focus";
import type { AtlasSelection } from "./scene";
import { createAtlasScene } from "./scene";
import type { TradeRoute } from "./trade-routes";
import type {
  AtlasData,
  AtlasFile,
  AtlasSymbol,
  FormerPackage,
  Territory,
} from "./types";
import { useBelonging } from "./use-belonging";
import { WreckDive } from "./wreck-dive";

function canonicalSelection(data: AtlasData, value: AtlasSelection | null) {
  if (!value) {
    return null;
  }
  const territory =
    data.territories.find((item) => item.id === value.territory.id) ??
    value.territory;
  return {
    ...value,
    file: territory.files.find((file) => file.id === value.file?.id),
    territory,
  };
}

function selectionGroup(
  value: AtlasSelection | null,
  layout: Territory | null
) {
  const territory =
    layout?.id === value?.territory.id ? layout : value?.territory;
  return (
    value?.neighborhoodId ??
    territory?.neighborhoods.find((group) =>
      group.members.includes(value?.file?.id ?? "")
    )?.id ??
    ""
  );
}

export default function Atlas({ data: sourceData }: { data: AtlasData }) {
  const [layoutSettings, setLayoutSettings] = useState(defaultLandmassSettings);
  const data = useMemo(
    () =>
      layoutSettings === defaultLandmassSettings
        ? sourceData
        : relayoutAtlas(sourceData, layoutSettings),
    [sourceData, layoutSettings]
  );
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<ReturnType<typeof createAtlasScene> | null>(null);
  const viewPreference = useRef<{
    x: number;
    y: number;
    pixels: number;
  } | null>(null);
  const playbackPreference = useRef<PlaybackSnapshot | null>(null);
  const [chosen, setSelection] = useState<AtlasSelection | null>(null);
  const [trades, setTrades] = useState<TradeRoute[]>([]);
  const [hover, setHover] = useState<AtlasSelection | null>(null);
  const [selectedWreck, setSelectedWreck] = useState<FormerPackage | null>(
    null
  );
  const [hoveredWreck, setHoveredWreck] = useState<FormerPackage | null>(null);
  const [wreckLedgerOpen, setWreckLedgerOpen] = useState(false);
  const [lens, setLens] = useState<"belonging" | "files">("belonging");
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const evidenceOpenRef = useRef(false);
  useEffect(() => {
    evidenceOpenRef.current = evidenceOpen;
  }, [evidenceOpen]);
  const [tracedSelection, setTracedSelection] = useState<AtlasSelection | null>(
    null
  );
  const [responsibilityOverlay, setResponsibilityOverlay] =
    useState<ResponsibilityOverlay | null>(null);
  const [territoryLayout, setTerritoryLayout] = useState<Territory | null>(
    null
  );
  const [viewTerritory, setViewTerritory] = useState<Territory | null>(null);
  const territoryLayoutRef = useRef<Territory | null>(null);
  const [atmosphereEnabled, setAtmosphereEnabled] = useState(false);
  const atmospherePreference = useRef(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsOpenRef = useRef(false);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const [chartSettings, setChartSettings] = useState({
    ...defaultChartSettings,
  });
  const chartPreference = useRef(chartSettings);
  const { coastalBuffer, islandClearance, layers } = chartSettings;
  const openSettings = useCallback(() => {
    settingsOpenRef.current = true;
    setSettingsOpen(true);
  }, [setSettingsOpen, settingsOpenRef]);
  const closeSettings = useCallback(() => {
    settingsOpenRef.current = false;
    setSettingsOpen(false);
    settingsButton.current?.focus();
  }, [setSettingsOpen, settingsButton, settingsOpenRef]);
  const [status, setStatus] = useState("Unfolding the atlas…");
  const territory = chosen?.territory;
  const viewBelonging = useBelonging(
    viewTerritory ?? undefined,
    data.generatedAt
  );
  const selectedBelonging = useBelonging(
    resolveSelectedBelonging(
      territory,
      viewTerritory,
      viewBelonging,
      territoryLayout
    ),
    data.generatedAt
  );
  const belonging =
    territory?.id === viewTerritory?.id && viewBelonging.data
      ? viewBelonging
      : selectedBelonging;
  const selection = useMemo(
    () =>
      chosen
        ? {
            ...chosen,
            ...belongingAncestry(belonging.regions, belonging.composites, {
              compositeId: chosen.compositeId,
              fileId: chosen.file?.id,
              regionId: chosen.regionId,
            }),
          }
        : null,
    [chosen, belonging.regions, belonging.composites]
  );
  const showConnections = selection !== null && tracedSelection === selection;
  const select = useCallback(
    (initialValue: AtlasSelection | null) => {
      let value = initialValue;
      setSelectedWreck(null);
      value = canonicalSelection(data, value);
      value = AtlasEntries(value, territory, belonging, selection);
      setSelection(value);
      setHover(null);
      if (!value) {
        setEvidenceOpen(false);
      }
      if (value?.regionId || value?.compositeId) {
        scene.current?.pinRegion();
      }
      if (value?.symbol) {
        setEvidenceOpen(true);
      }
      const group = selectionGroup(value, territoryLayoutRef.current);
      if (!value?.symbol && value?.file) {
        scene.current?.focus(value.territory, value.file, group);
      } else if (!(value?.symbol || value?.regionId || value?.compositeId)) {
        scene.current?.focus(value?.territory ?? null, value?.file, group);
      }
    },
    [
      belonging,
      data,
      scene,
      selection,
      setEvidenceOpen,
      setHover,
      setSelectedWreck,
      setSelection,
      territory,
      territoryLayoutRef,
    ]
  );
  const selectRef = useRef(select);
  const selectionRef = useRef(selection);
  useEffect(() => {
    selectRef.current = select;
    selectionRef.current = selection;
  });
  useEffect(() => {
    if (
      coastalBuffer === layoutSettings.coastalBuffer &&
      islandClearance === layoutSettings.islandClearance
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      setSelection(null);
      setHover(null);
      setTerritoryLayout(null);
      territoryLayoutRef.current = null;
      setResponsibilityOverlay(null);
      setTracedSelection(null);
      setEvidenceOpen(false);
      setLayoutSettings({ coastalBuffer, islandClearance });
    }, 300);
    return () => {
      clearTimeout(timer);
    };
  }, [coastalBuffer, islandClearance, layoutSettings]);
  useEffect(() => {
    let disposed = false;
    Promise.all([
      document.fonts.load("16px AtlasDisplay"),
      document.fonts.load("12px AtlasBody"),
    ]).then(() => {
      if (disposed || !host.current) {
        return;
      }
      try {
        scene.current = createAtlasScene(
          host.current,
          data,
          (value) => {
            selectRef.current(value);
          },
          setHover,
          openSettings,
          setTrades,
          layoutSettings.coastalBuffer,
          layers,
          (wreck, selected) => {
            if (selected && wreck) {
              setSelectedWreck(wreck);
              setWreckLedgerOpen(false);
              scene.current?.focusWreck(wreck);
            } else if (!selected) {
              setHoveredWreck(wreck);
            }
          },
          setViewTerritory
        );
        scene.current.setAtmosphere(atmospherePreference.current);
        scene.current.configure(chartPreference.current);
        // biome-ignore lint/suspicious/noUnnecessaryConditions: React assigns and updates this ref between renders and effects.
        if (viewPreference.current) {
          scene.current.restoreView(viewPreference.current);
        }
        // biome-ignore lint/suspicious/noUnnecessaryConditions: React assigns and updates this ref between renders and effects.
        if (playbackPreference.current) {
          scene.current.restorePlayback(playbackPreference.current);
        }
        setStatus("");
      } catch {
        setStatus(
          "The map could not open. Use Find a place, or reload in a browser with WebGL enabled."
        );
      }
    });
    const currentEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // biome-ignore lint/suspicious/noUnnecessaryConditions: React assigns and updates this ref between renders and effects.
        if (settingsOpenRef.current) {
          closeSettings();
          return;
        }
        // biome-ignore lint/suspicious/noUnnecessaryConditions: React assigns and updates this ref between renders and effects.
        if (evidenceOpenRef.current) {
          setEvidenceOpen(false);
          return;
        }
        const { current } = selectionRef;
        selectRef.current(resolveCurrentEscape(current));
      }
    };
    window.addEventListener("keydown", currentEscape);
    return () => {
      disposed = true;
      viewPreference.current = scene.current?.captureView() ?? null;
      playbackPreference.current = scene.current?.getPlayback() ?? null;
      scene.current?.dispose();
      scene.current = null;
      window.removeEventListener("keydown", currentEscape);
    };
  }, [data, layoutSettings.coastalBuffer, layers]);
  const selectedRegion = belonging.regions.find(
    (region) => region.id === selection?.regionId
  );
  const selectedComposite = belonging.composites.find(
    (region) => region.id === selection?.compositeId
  );
  const viewIsSelected =
    viewTerritory !== null && viewTerritory.id === territory?.id;
  const mapBelonging = viewIsSelected ? belonging : viewBelonging;
  useEffect(() => {
    scene.current?.setBelonging(
      resolveValue(
        viewTerritory,
        lens,
        viewIsSelected,
        selectedRegion,
        selectedComposite,
        selection,
        mapBelonging,
        belonging,
        territoryLayout
      )
    );
  }, [
    viewTerritory,
    territoryLayout,
    viewIsSelected,
    mapBelonging.regions,
    mapBelonging.composites,
    belonging.composites,
    selectedRegion,
    selectedComposite,
    lens,
    selection?.regionId,
    selection?.file?.id,
  ]);
  useEffect(() => {
    territoryLayoutRef.current = territoryLayout;
    scene.current?.setTerritoryLayout(territoryLayout);
  }, [territoryLayout]);
  useEffect(() => {
    scene.current?.setConnections(showConnections);
    scene.current?.setResponsibility(
      !showConnections && responsibilityOverlay?.territoryId === territory?.id
        ? responsibilityOverlay
        : null
    );
  }, [responsibilityOverlay, territory?.id, showConnections]);
  const inspected = hover ?? selection;
  const inspectedWreck = hoveredWreck ?? selectedWreck;
  const inspectedRegion =
    belonging.regions.find((region) => region.id === inspected?.regionId) ??
    belonging.composites.find((region) => region.id === inspected?.compositeId);
  const handleEvidenceOpen = useCallback(() => {
    setEvidenceOpen(true);
  }, [setEvidenceOpen]);
  const handleFrame = useCallback(
    (ids: string[]) => {
      if (territory) {
        scene.current?.focus(territory, undefined, undefined, ids);
      }
    },
    [scene, territory]
  );
  const handleLens = useCallback(
    (value: "belonging" | "files") => {
      setLens(value);
      if ((selection?.regionId || selection?.compositeId) && territory) {
        select({ territory });
      }
    },
    [select, selection, setLens, territory]
  );
  const handleTracedSelection = useCallback(() => {
    setTracedSelection(showConnections ? null : selection);
  }, [selection, setTracedSelection, showConnections]);
  const handleEvidenceOpen2 = useCallback(() => {
    setEvidenceOpen(false);
  }, [setEvidenceOpen]);
  const handleDistrict = useCallback(
    (id: string) => {
      if (!territory) {
        return;
      }
      select({ regionId: id || undefined, territory });
    },
    [select, territory]
  );
  const handleFile = useCallback(
    (file: AtlasFile, symbol: AtlasSymbol | undefined) => {
      if (territory) {
        select({ file, symbol, territory });
      }
    },
    [select, territory]
  );
  const handleFrame2 = useCallback(
    (ids: string[], districtId: string | undefined) => {
      if (!territory) {
        return;
      }
      if (districtId) {
        select({ regionId: districtId, territory });
      }
      setHover(null);
      scene.current?.focus(territory, undefined, undefined, ids);
    },
    [scene, select, setHover, territory]
  );
  const handleUnmappedModule = useCallback(
    (module: string) => {
      if (!territory) {
        return;
      }
      select({ territory, unmappedModule: module || undefined });
    },
    [select, territory]
  );
  const handleSelection = useCallback(
    (next: {
      boundaries: BoundaryVisibility;
      contours: boolean;
      currentSpeed: number;
      dependencyInfluence: number;
      filter: keyof typeof chartFilters;
      layers: {
        forests: boolean;
        houses: boolean;
        land: boolean;
        roads: boolean;
        trade: boolean;
      };
      waterColor: string;
      waterContrast: number;
      waveAmount: number;
      wavelength: number;
      waveStrength: number;
      windDirection: number;
      windInfluence: number;
      windStrength: number;
      coastalBuffer: number;
      islandClearance: number;
    }) => {
      if (next.layers !== chartPreference.current.layers) {
        setSelection(null);
        setHover(null);
        setEvidenceOpen(false);
      }
      chartPreference.current = next;
      setChartSettings(next);
      scene.current?.configure(next);
    },
    [
      chartPreference,
      scene,
      setChartSettings,
      setEvidenceOpen,
      setHover,
      setSelection,
    ]
  );
  const handleSelection2 = useCallback(() => {
    setSelection(null);
    setHover(null);
    setEvidenceOpen(false);
    const next = { ...defaultChartSettings };
    chartPreference.current = next;
    setChartSettings(next);
    scene.current?.configure(next);
    for (const id of trackIds) {
      scene.current?.setTrackPlaying(id, true);
    }
    scene.current?.setPlaybackSpeed(1);
    scene.current?.seek(0);
    scene.current?.play(
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
    atmospherePreference.current = false;
    setAtmosphereEnabled(false);
    scene.current?.setAtmosphere(false);
  }, [
    atmospherePreference,
    chartPreference,
    scene,
    setAtmosphereEnabled,
    setChartSettings,
    setEvidenceOpen,
    setHover,
    setSelection,
  ]);
  const handleWreckLedgerOpen = useCallback(() => {
    setWreckLedgerOpen(false);
  }, [setWreckLedgerOpen]);
  const handleWreckLedgerOpen2 = useCallback(() => {
    setWreckLedgerOpen(!wreckLedgerOpen);
  }, [setWreckLedgerOpen, wreckLedgerOpen]);
  const handleClick = useCallback(() => {
    if (settingsOpen) {
      closeSettings();
    } else {
      openSettings();
    }
  }, [closeSettings, openSettings, settingsOpen]);
  const handleAtmosphereEnabled = useCallback(() => {
    const enabled = !atmosphereEnabled;
    atmospherePreference.current = enabled;
    setAtmosphereEnabled(enabled);
    scene.current?.setAtmosphere(enabled);
  }, [atmosphereEnabled, atmospherePreference, scene, setAtmosphereEnabled]);
  const handleClick2 = useCallback(
    () => scene.current?.zoom(1 / 1.35),
    [scene]
  );
  const handleClick3 = useCallback(() => {
    select(null);
  }, [select]);
  const handleClick4 = useCallback(() => scene.current?.zoom(1.35), [scene]);
  const handleSelectedWreck2 = useCallback(() => {
    setSelectedWreck(null);
  }, [setSelectedWreck]);
  return (
    <main className="atlas-app atlas-map-first">
      <AtlasNavigation
        composites={belonging.composites}
        data={data}
        error={belonging.error}
        lens={lens}
        loading={belonging.loading}
        onEvidence={handleEvidenceOpen}
        onFrame={handleFrame}
        onLens={handleLens}
        onRetry={belonging.retry}
        onSelect={select}
        onTrace={handleTracedSelection}
        regions={belonging.regions}
        selection={selection}
        tracing={showConnections}
        trades={trades}
      />
      {territory &&
        selection &&
        (selection.file !== undefined || evidenceOpen) && (
          <aside
            aria-label="Architectural evidence"
            className="atlas-evidence-drawer"
            hidden={!evidenceOpen}
          >
            <button
              className="atlas-back"
              onClick={handleEvidenceOpen2}
              type="button"
            >
              Close evidence
            </button>
            <h2>{territory.label}</h2>
            <ArchitecturePanel
              districtId={selection.regionId ?? selection.neighborhoodId}
              file={selection.file}
              key={territory.id}
              onDistrict={handleDistrict}
              onFile={handleFile}
              onFrame={handleFrame2}
              onLayout={setTerritoryLayout}
              onOverlay={setResponsibilityOverlay}
              onUnmappedModule={handleUnmappedModule}
              survey={data.generatedAt}
              symbol={selection.symbol}
              territory={territory}
              unmappedModule={selection.unmappedModule}
            />
          </aside>
        )}
      <section
        aria-label="Interactive atlas"
        className={`atlas-world${settingsOpen ? "atlas-settings-open" : ""}`}
      >
        <div
          className="atlas-map"
          ref={host}
          style={{ filter: chartFilters[chartSettings.filter].filter }}
        />
        {settingsOpen && (
          <ChartSettingsPanel
            layoutPending={
              coastalBuffer !== layoutSettings.coastalBuffer ||
              islandClearance !== layoutSettings.islandClearance
            }
            onChange={handleSelection}
            onClose={closeSettings}
            onReset={handleSelection2}
            scene={scene}
            settings={chartSettings}
          />
        )}
        {status && (
          <p className="atlas-status" role="status">
            {status}
          </p>
        )}
        {wreckLedgerOpen && !!data.formerPackages?.length && (
          <aside aria-label="Former packages" className="atlas-wreck-ledger">
            <div className="atlas-wreck-heading">
              <h2>Former packages</h2>
              <button
                aria-label="Close former packages"
                onClick={handleWreckLedgerOpen}
                type="button"
              >
                Close
              </button>
            </div>
            <p>Present in a historical checkpoint; absent from this survey.</p>
            <div className="atlas-wreck-list">
              {data.formerPackages.map((wreck) => {
                const handleSelectedWreck = () => {
                  setSelectedWreck(wreck);
                  setWreckLedgerOpen(false);
                  scene.current?.focusWreck(wreck);
                };
                return (
                  <button
                    aria-current={
                      selectedWreck?.id === wreck.id ? "true" : undefined
                    }
                    key={wreck.id}
                    onClick={handleSelectedWreck}
                    type="button"
                  >
                    <span>{wreck.id}</span>
                    <small>
                      Last observed {wreck.lastObserved.slice(0, 10)}
                    </small>
                  </button>
                );
              })}
            </div>
          </aside>
        )}
        <div className="atlas-map-bottom">
          <div aria-live="polite" className="atlas-inspection" role="status">
            {resolveAtlas(inspectedWreck, inspected, inspectedRegion)}
          </div>
          {!!data.formerPackages?.length && (
            <button
              aria-expanded={wreckLedgerOpen}
              className="atlas-wreck-toggle"
              onClick={handleWreckLedgerOpen2}
              type="button"
            >
              Wrecks <span>{data.formerPackages.length}</span>
            </button>
          )}
          <fieldset aria-label="Map controls" className="atlas-controls">
            <button
              aria-controls={settingsOpen ? "atlas-chart-settings" : undefined}
              aria-expanded={settingsOpen}
              aria-label="Chart settings"
              onClick={handleClick}
              ref={settingsButton}
              title="Chart settings and playback"
              type="button"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="9" />
                <path d="m16 8-2.5 5.5L8 16l2.5-5.5Z" />
              </svg>
            </button>
            <button
              aria-label="Decorative atmosphere"
              aria-pressed={atmosphereEnabled}
              onClick={handleAtmosphereEnabled}
              title="Dependency currents, wind and coastlight"
              type="button"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M3 8h12c5 0 5-6 1-6M3 12h16c4 0 4 6 0 6M3 16h6c4 0 4 5 1 5" />
              </svg>
            </button>
            <button aria-label="Zoom out" onClick={handleClick2} type="button">
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M5 12h14" />
              </svg>
            </button>
            <button
              aria-label="Whole atlas"
              onClick={handleClick3}
              type="button"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4" />
              </svg>
            </button>
            <button aria-label="Zoom in" onClick={handleClick4} type="button">
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M5 12h14M12 5v14" />
              </svg>
            </button>
          </fieldset>
        </div>
        {selectedWreck && (
          <WreckDive onClose={handleSelectedWreck2} wreck={selectedWreck} />
        )}
      </section>
    </main>
  );
}

function resolveAtlas(
  inspectedWreck: FormerPackage | null,
  inspected: AtlasSelection | null,
  inspectedRegion: BelongingRegion | undefined
): React.ReactNode {
  if (inspectedWreck) {
    return (
      <>
        <strong>{inspectedWreck.id}</strong>
        <span>
          Former package · Last observed{" "}
          {inspectedWreck.lastObserved.slice(0, 10)}
        </span>
      </>
    );
  }
  if (inspected) {
    return (
      <>
        <strong>
          {inspected.symbol
            ? `${inspected.symbol.name} · ${inspected.file?.path ?? inspected.territory.id}`
            : (inspected.file?.path ??
              inspectedRegion?.label ??
              inspected.territory.label)}
        </strong>
        <span>{resolveResolveAtlas(inspected, inspectedRegion)}</span>
      </>
    );
  }
  return (
    <>
      <strong>The Foundry archipelago</strong>
      <span>Drag to explore · Scroll to move closer · Select a territory</span>
    </>
  );
}

function resolveResolveAtlas(
  inspected: AtlasSelection,
  inspectedRegion: BelongingRegion | undefined
): React.ReactNode {
  if (inspected.file) {
    return `${inspected.file.kind} · ${inspected.file.incoming} incoming imports · ${inspected.file.outgoing} outgoing imports`;
  }
  if (inspectedRegion) {
    return `${inspectedRegion.members.length} files · ${inspectedRegion.children ? "Enter district" : "Enter responsibility"}`;
  }
  return `${inspected.territory.files.length} files · ${inspected.territory.analyzed ? "Select to explore" : "Not analyzed"}`;
}

function resolveValue(
  viewTerritory: Territory | null,
  lens: "belonging" | "files",
  viewIsSelected: boolean,
  selectedRegion: BelongingRegion | undefined,
  selectedComposite: BelongingRegion | undefined,
  selection: {
    compositeId: string | undefined;
    regionId: string | undefined;
    file?: AtlasFile;
    neighborhoodId?: string;
    symbol?: { id: string; name: string };
    territory: Territory;
    unmappedModule?: string;
  } | null,
  mapBelonging: {
    composites: BelongingRegion[];
    data: AtlasInternals | undefined;
    error: string | undefined;
    loading: boolean;
    regions: BelongingRegion[];
    retry: () => void;
  },
  belonging: {
    composites: BelongingRegion[];
    data: AtlasInternals | undefined;
    error: string | undefined;
    loading: boolean;
    regions: BelongingRegion[];
    retry: () => void;
  },
  territoryLayout: Territory | null
): BelongingLayer | null {
  if (viewTerritory && lens === "belonging") {
    return {
      files: viewIsSelected ? selectedRegion?.members : undefined,
      parents: resolveParents(
        viewIsSelected,
        selectedComposite,
        selectedRegion
      ),
      pinned: viewIsSelected ? selection?.regionId : undefined,
      regions: resolveRegions(
        viewIsSelected,
        selectedRegion,
        selectedComposite,
        mapBelonging
      ),
      surroundings:
        viewIsSelected && selectedComposite
          ? belonging.composites.filter(
              (region) => region !== selectedComposite && !region.collection
            )
          : [],
      territory:
        territoryLayout?.id === viewTerritory.id
          ? territoryLayout
          : viewTerritory,
    };
  }
  return null;
}

function resolveRegions(
  viewIsSelected: boolean,
  selectedRegion: BelongingRegion | undefined,
  selectedComposite: BelongingRegion | undefined,
  mapBelonging: {
    composites: BelongingRegion[];
    data: AtlasInternals | undefined;
    error: string | undefined;
    loading: boolean;
    regions: BelongingRegion[];
    retry: () => void;
  }
): BelongingRegion[] {
  if (viewIsSelected && selectedRegion) {
    return [];
  }
  if (viewIsSelected && selectedComposite) {
    return mapBelonging.regions.filter((region) =>
      selectedComposite.children?.includes(region.id)
    );
  }
  if (mapBelonging.composites.length) {
    return mapBelonging.composites;
  }
  return mapBelonging.regions;
}

function resolveParents(
  viewIsSelected: boolean,
  selectedComposite: BelongingRegion | undefined,
  selectedRegion: BelongingRegion | undefined
): BelongingRegion[] {
  if (viewIsSelected) {
    return [selectedComposite, selectedRegion].flatMap((region) =>
      region ? [region] : []
    );
  }
  return [];
}

function resolveCurrentEscape(
  current: {
    compositeId: string | undefined;
    regionId: string | undefined;
    file?: AtlasFile;
    neighborhoodId?: string;
    symbol?: { id: string; name: string };
    territory: Territory;
    unmappedModule?: string;
  } | null
): AtlasSelection | null {
  if (current?.file) {
    return {
      compositeId: current.compositeId,
      regionId: current.regionId,
      territory: current.territory,
    };
  }
  if (current?.regionId) {
    return {
      compositeId: current.compositeId,
      territory: current.territory,
    };
  }
  if (current?.compositeId) {
    return { territory: current.territory };
  }
  return null;
}

function resolveSelectedBelonging(
  territory: Territory | undefined,
  viewTerritory: Territory | null,
  viewBelonging: {
    composites: BelongingRegion[];
    data: AtlasInternals | undefined;
    error: string | undefined;
    loading: boolean;
    regions: BelongingRegion[];
    retry: () => void;
  },
  territoryLayout: Territory | null
): Territory | undefined {
  if (territory?.id === viewTerritory?.id && viewBelonging.data) {
    return undefined;
  }
  if (territoryLayout?.id === territory?.id) {
    return territoryLayout ?? undefined;
  }
  return territory;
}

function AtlasEntries(
  initialValue: AtlasSelection | null,
  territory: Territory | undefined,
  belonging: {
    composites: BelongingRegion[];
    data: AtlasInternals | undefined;
    error: string | undefined;
    loading: boolean;
    regions: BelongingRegion[];
    retry: () => void;
  },
  selection: {
    compositeId: string | undefined;
    regionId: string | undefined;
    file?: AtlasFile;
    neighborhoodId?: string;
    symbol?: { id: string; name: string };
    territory: Territory;
    unmappedModule?: string;
  } | null
): AtlasSelection | null {
  let value = initialValue;
  if (value && value.territory.id === territory?.id) {
    value = {
      ...value,
      ...belongingAncestry(belonging.regions, belonging.composites, {
        compositeId:
          value.compositeId ??
          (value.file || value.regionId ? selection?.compositeId : undefined),
        fileId: value.file?.id,
        regionId:
          value.regionId ?? (value.file ? selection?.regionId : undefined),
      }),
    };
  }
  return value;
}
