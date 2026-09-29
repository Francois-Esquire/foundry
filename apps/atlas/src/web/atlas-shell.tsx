import {
  type MouseEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { ArchitecturePanel } from "./architecture-panel";
import { AtlasNavigation } from "./atlas-navigation";
import type { AtlasState } from "./atlas-state";
import type { BelongingRegion } from "./belonging";
import { ChartSettingsPanel } from "./chart-settings-panel";
import type { AtlasSelection } from "./scene";
import type { FormerPackage } from "./types";
import type { useAtlasState } from "./use-atlas-state";
import { WreckDive } from "./wreck-dive";

export interface AtlasShellHandle {
  openSettings: () => void;
}

export function AtlasShell({
  state,
  actions,
  children,
  ref,
}: {
  state: AtlasState;
  actions: Omit<ReturnType<typeof useAtlasState>, "state">;
  children: ReactNode;
  ref?: Ref<AtlasShellHandle>;
}) {
  const {
    data,
    selection,
    hover,
    selectedWreck,
    hoveredWreck,
    lens,
    trades,
    atmosphereEnabled,
    chartSettings,
    layoutSettings,
    showConnections,
  } = state;
  const { coastalBuffer, islandClearance } = chartSettings;
  const {
    scene,
    belonging,
    select,
    frame: frameSelection,
    lens: changeLens,
    trace: toggleTrace,
    district: selectDistrict,
    file: selectFile,
    frameDistrict,
    layout: setTerritoryLayout,
    overlay: setResponsibilityOverlay,
    unmappedModule: selectUnmappedModule,
    settings: changeSettings,
    reset: resetSettings,
    atmosphere: toggleAtmosphere,
    closeWreck,
  } = actions;
  const territory = selection?.territory;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [wreckLedgerOpen, setWreckLedgerOpen] = useState(false);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    settingsButton.current?.focus();
  }, []);
  useImperativeHandle(ref, () => ({ openSettings }), [openSettings]);
  useEffect(() => {
    if (!selection) {
      setEvidenceOpen(false);
    } else if (selection.symbol) {
      setEvidenceOpen(true);
    }
  }, [selection]);
  useEffect(() => {
    if (selectedWreck) {
      setWreckLedgerOpen(false);
    }
  }, [selectedWreck]);
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      if (settingsOpen) {
        event.preventDefault();
        closeSettings();
      } else if (evidenceOpen) {
        event.preventDefault();
        setEvidenceOpen(false);
      }
    };
    window.addEventListener("keydown", handleEscape, true);
    return () => window.removeEventListener("keydown", handleEscape, true);
  }, [settingsOpen, evidenceOpen, closeSettings]);

  const openEvidence = useCallback(() => setEvidenceOpen(true), []);
  const closeEvidence = useCallback(() => setEvidenceOpen(false), []);
  const closeWreckLedger = useCallback(() => setWreckLedgerOpen(false), []);
  const toggleWreckLedger = useCallback(
    () => setWreckLedgerOpen((open) => !open),
    []
  );
  const toggleSettings = useCallback(() => {
    if (settingsOpen) {
      closeSettings();
    } else {
      openSettings();
    }
  }, [settingsOpen, closeSettings, openSettings]);
  const zoomOut = useCallback(() => scene.current?.zoom(1 / 1.35), [scene]);
  const showWholeAtlas = useCallback(() => select(null), [select]);
  const zoomIn = useCallback(() => scene.current?.zoom(1.35), [scene]);
  const selectWreck = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const wreck = data.formerPackages?.find(
        (item) => item.id === event.currentTarget.value
      );
      if (wreck) {
        actions.wreck(wreck, true);
        setWreckLedgerOpen(false);
      }
    },
    [data.formerPackages, actions.wreck]
  );
  const inspected = hover ?? selection;
  const inspectedWreck = hoveredWreck ?? selectedWreck;
  const inspectedRegion =
    belonging.regions.find((region) => region.id === inspected?.regionId) ??
    belonging.composites.find((region) => region.id === inspected?.compositeId);
  return (
    <main className="atlas-app atlas-map-first atlas-shell">
      <AtlasNavigation
        composites={belonging.composites}
        data={data}
        error={belonging.error}
        lens={lens}
        loading={belonging.loading}
        onEvidence={openEvidence}
        onFrame={frameSelection}
        onLens={changeLens}
        onRetry={belonging.retry}
        onSelect={select}
        onTrace={toggleTrace}
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
              onClick={closeEvidence}
              type="button"
            >
              Close evidence
            </button>
            <h2>{territory.label}</h2>
            <ArchitecturePanel
              districtId={selection.regionId ?? selection.neighborhoodId}
              file={selection.file}
              key={territory.id}
              onDistrict={selectDistrict}
              onFile={selectFile}
              onFrame={frameDistrict}
              onLayout={setTerritoryLayout}
              onOverlay={setResponsibilityOverlay}
              onUnmappedModule={selectUnmappedModule}
              survey={data.generatedAt}
              symbol={selection.symbol}
              territory={territory}
              unmappedModule={selection.unmappedModule}
            />
          </aside>
        )}
      <div
        className={`atlas-world${settingsOpen ? "atlas-settings-open" : ""}`}
      >
        {children}
        {settingsOpen && (
          <ChartSettingsPanel
            layoutPending={
              coastalBuffer !== layoutSettings.coastalBuffer ||
              islandClearance !== layoutSettings.islandClearance
            }
            onChange={changeSettings}
            onClose={closeSettings}
            onReset={resetSettings}
            scene={scene}
            settings={chartSettings}
          />
        )}
        {wreckLedgerOpen && !!data.formerPackages?.length && (
          <aside aria-label="Former packages" className="atlas-wreck-ledger">
            <div className="atlas-wreck-heading">
              <h2>Former packages</h2>
              <button
                aria-label="Close former packages"
                onClick={closeWreckLedger}
                type="button"
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
                  onClick={selectWreck}
                  type="button"
                  value={wreck.id}
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
            {resolveAtlas(inspectedWreck, inspected, inspectedRegion)}
          </div>
          {!!data.formerPackages?.length && (
            <button
              aria-expanded={wreckLedgerOpen}
              className="atlas-wreck-toggle"
              onClick={toggleWreckLedger}
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
              onClick={toggleSettings}
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
              onClick={toggleAtmosphere}
              title="Dependency currents, wind and coastlight"
              type="button"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M3 8h12c5 0 5-6 1-6M3 12h16c4 0 4 6 0 6M3 16h6c4 0 4 5 1 5" />
              </svg>
            </button>
            <button aria-label="Zoom out" onClick={zoomOut} type="button">
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M5 12h14" />
              </svg>
            </button>
            <button
              aria-label="Whole atlas"
              onClick={showWholeAtlas}
              type="button"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4" />
              </svg>
            </button>
            <button aria-label="Zoom in" onClick={zoomIn} type="button">
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M5 12h14M12 5v14" />
              </svg>
            </button>
          </fieldset>
        </div>
        {selectedWreck && (
          <WreckDive onClose={closeWreck} wreck={selectedWreck} />
        )}
      </div>
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
