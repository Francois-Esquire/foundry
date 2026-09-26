import { useEffect, useMemo, useRef, useState } from "react";
import { ArchitecturePanel } from "./ArchitecturePanel";
import { AtlasNavigation } from "./AtlasNavigation";
import { belongingAncestry } from "./belonging";
import { ChartSettingsPanel } from "./ChartSettingsPanel";
import { chartFilters, defaultChartSettings } from "./chart-settings";
import { defaultLandmassSettings, relayoutAtlas } from "./landmasses";
import type { PlaybackSnapshot } from "./playback";
import { trackIds } from "./playback";
import type { ResponsibilityOverlay } from "./responsibility-focus";
import type { AtlasSelection } from "./scene";
import { createAtlasScene } from "./scene";
import type { TradeRoute } from "./trade-routes";
import type { AtlasData, FormerPackage, Territory } from "./types";
import { useBelonging } from "./use-belonging";
import { WreckDive } from "./WreckDive";

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
  const openSettings = () => {
    settingsOpenRef.current = true;
    setSettingsOpen(true);
  };
  const closeSettings = () => {
    settingsOpenRef.current = false;
    setSettingsOpen(false);
    settingsButton.current?.focus();
  };
  const [status, setStatus] = useState("Unfolding the atlas…");
  const territory = chosen?.territory;
  const viewBelonging = useBelonging(
    viewTerritory ?? undefined,
    data.generatedAt
  );
  const selectedBelonging = useBelonging(
    territory?.id === viewTerritory?.id && viewBelonging.data
      ? undefined
      : territoryLayout?.id === territory?.id
        ? (territoryLayout ?? undefined)
        : territory,
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
  const select = (value: AtlasSelection | null) => {
    setSelectedWreck(null);
    value = canonicalSelection(data, value);
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
  };
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
    void Promise.all([
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
        if (viewPreference.current) {
          scene.current.restoreView(viewPreference.current);
        }
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
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (settingsOpenRef.current) {
          closeSettings();
          return;
        }
        if (evidenceOpenRef.current) {
          setEvidenceOpen(false);
          return;
        }
        const current = selectionRef.current;
        selectRef.current(
          current?.file
            ? {
                compositeId: current.compositeId,
                regionId: current.regionId,
                territory: current.territory,
              }
            : current?.regionId
              ? {
                  compositeId: current.compositeId,
                  territory: current.territory,
                }
              : current?.compositeId
                ? { territory: current.territory }
                : null
        );
      }
    };
    window.addEventListener("keydown", escape);
    return () => {
      disposed = true;
      viewPreference.current = scene.current?.captureView() ?? null;
      playbackPreference.current = scene.current?.getPlayback() ?? null;
      scene.current?.dispose();
      scene.current = null;
      window.removeEventListener("keydown", escape);
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
      viewTerritory && lens === "belonging"
        ? {
            files: viewIsSelected ? selectedRegion?.members : undefined,
            parents: viewIsSelected
              ? [selectedComposite, selectedRegion].flatMap((region) =>
                  region ? [region] : []
                )
              : [],
            pinned: viewIsSelected ? selection?.regionId : undefined,
            regions:
              viewIsSelected && selectedRegion
                ? []
                : viewIsSelected && selectedComposite
                  ? mapBelonging.regions.filter((region) =>
                      selectedComposite.children?.includes(region.id)
                    )
                  : mapBelonging.composites.length
                    ? mapBelonging.composites
                    : mapBelonging.regions,
            surroundings:
              viewIsSelected && selectedComposite
                ? belonging.composites.filter(
                    (region) =>
                      region !== selectedComposite && !region.collection
                  )
                : [],
            territory:
              territoryLayout?.id === viewTerritory.id
                ? territoryLayout
                : viewTerritory,
          }
        : null
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
  return (
    <main className="atlas-app atlas-map-first">
      <AtlasNavigation
        composites={belonging.composites}
        data={data}
        error={belonging.error}
        lens={lens}
        loading={belonging.loading}
        onEvidence={() => {
          setEvidenceOpen(true);
        }}
        onFrame={(ids) => {
          if (territory) {
            scene.current?.focus(territory, undefined, undefined, ids);
          }
        }}
        onLens={(value) => {
          setLens(value);
          if ((selection?.regionId || selection?.compositeId) && territory) {
            select({ territory });
          }
        }}
        onRetry={belonging.retry}
        onSelect={select}
        onTrace={() => {
          setTracedSelection(showConnections ? null : selection);
        }}
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
              onClick={() => {
                setEvidenceOpen(false);
              }}
            >
              Close evidence
            </button>
            <h2>{territory.label}</h2>
            <ArchitecturePanel
              districtId={selection.regionId ?? selection.neighborhoodId}
              file={selection.file}
              key={territory.id}
              onDistrict={(id) => {
                select({ regionId: id || undefined, territory });
              }}
              onFile={(file, symbol) => {
                select({ file, symbol, territory });
              }}
              onFrame={(ids, districtId) => {
                if (districtId) {
                  select({ regionId: districtId, territory });
                }
                setHover(null);
                scene.current?.focus(territory, undefined, undefined, ids);
              }}
              onLayout={setTerritoryLayout}
              onOverlay={setResponsibilityOverlay}
              onUnmappedModule={(module) => {
                select({ territory, unmappedModule: module || undefined });
              }}
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
            onChange={(next) => {
              if (next.layers !== chartPreference.current.layers) {
                setSelection(null);
                setHover(null);
                setEvidenceOpen(false);
              }
              chartPreference.current = next;
              setChartSettings(next);
              scene.current?.configure(next);
            }}
            onClose={closeSettings}
            onReset={() => {
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
            }}
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
                onClick={() => {
                  setWreckLedgerOpen(false);
                }}
              >
                Close
              </button>
            </div>
            <p>Present in a historical checkpoint; absent from this survey.</p>
            <div className="atlas-wreck-list">
              {data.formerPackages.map((wreck) => (
                <button
                  aria-current={
                    selectedWreck?.id === wreck.id ? "true" : undefined
                  }
                  key={wreck.id}
                  onClick={() => {
                    setSelectedWreck(wreck);
                    setWreckLedgerOpen(false);
                    scene.current?.focusWreck(wreck);
                  }}
                >
                  <span>{wreck.id}</span>
                  <small>Last observed {wreck.lastObserved.slice(0, 10)}</small>
                </button>
              ))}
            </div>
          </aside>
        )}
        <div className="atlas-map-bottom">
          <div aria-live="polite" className="atlas-inspection" role="status">
            {inspectedWreck ? (
              <>
                <strong>{inspectedWreck.id}</strong>
                <span>
                  Former package · Last observed{" "}
                  {inspectedWreck.lastObserved.slice(0, 10)}
                </span>
              </>
            ) : inspected ? (
              <>
                <strong>
                  {inspected.symbol
                    ? `${inspected.symbol.name} · ${inspected.file?.path ?? inspected.territory.id}`
                    : (inspected.file?.path ??
                      inspectedRegion?.label ??
                      inspected.territory.label)}
                </strong>
                <span>
                  {inspected.file
                    ? `${inspected.file.kind} · ${inspected.file.incoming} incoming imports · ${inspected.file.outgoing} outgoing imports`
                    : inspectedRegion
                      ? `${inspectedRegion.members.length} files · ${inspectedRegion.children ? "Enter district" : "Enter responsibility"}`
                      : `${inspected.territory.files.length} files · ${inspected.territory.analyzed ? "Select to explore" : "Not analyzed"}`}
                </span>
              </>
            ) : (
              <>
                <strong>The Foundry archipelago</strong>
                <span>
                  Drag to explore · Scroll to move closer · Select a territory
                </span>
              </>
            )}
          </div>
          {!!data.formerPackages?.length && (
            <button
              aria-expanded={wreckLedgerOpen}
              className="atlas-wreck-toggle"
              onClick={() => {
                setWreckLedgerOpen(!wreckLedgerOpen);
              }}
            >
              Wrecks <span>{data.formerPackages.length}</span>
            </button>
          )}
          <div aria-label="Map controls" className="atlas-controls">
            <button
              aria-controls={settingsOpen ? "atlas-chart-settings" : undefined}
              aria-expanded={settingsOpen}
              aria-label="Chart settings"
              onClick={() => {
                if (settingsOpen) {
                  closeSettings();
                } else {
                  openSettings();
                }
              }}
              ref={settingsButton}
              title="Chart settings and playback"
            >
              <svg viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="9" />
                <path d="m16 8-2.5 5.5L8 16l2.5-5.5Z" />
              </svg>
            </button>
            <button
              aria-label="Decorative atmosphere"
              aria-pressed={atmosphereEnabled}
              onClick={() => {
                const enabled = !atmosphereEnabled;
                atmospherePreference.current = enabled;
                setAtmosphereEnabled(enabled);
                scene.current?.setAtmosphere(enabled);
              }}
              title="Dependency currents, wind and coastlight"
            >
              <svg viewBox="0 0 24 24">
                <path d="M3 8h12c5 0 5-6 1-6M3 12h16c4 0 4 6 0 6M3 16h6c4 0 4 5 1 5" />
              </svg>
            </button>
            <button
              aria-label="Zoom out"
              onClick={() => scene.current?.zoom(1 / 1.35)}
            >
              <svg viewBox="0 0 24 24">
                <path d="M5 12h14" />
              </svg>
            </button>
            <button
              aria-label="Whole atlas"
              onClick={() => {
                select(null);
              }}
            >
              <svg viewBox="0 0 24 24">
                <path d="M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4" />
              </svg>
            </button>
            <button
              aria-label="Zoom in"
              onClick={() => scene.current?.zoom(1.35)}
            >
              <svg viewBox="0 0 24 24">
                <path d="M5 12h14M12 5v14" />
              </svg>
            </button>
          </div>
        </div>
        {selectedWreck && (
          <WreckDive
            onClose={() => {
              setSelectedWreck(null);
            }}
            wreck={selectedWreck}
          />
        )}
      </section>
    </main>
  );
}
