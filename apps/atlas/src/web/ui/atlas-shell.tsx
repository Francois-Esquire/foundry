import {
  lazy,
  type ReactNode,
  type Ref,
  Suspense,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { AtlasSelection } from "../scene/scene";
import type { FormerPackage } from "../types";
import { AtlasHeader } from "./atlas-header";
import { AtlasPanel, type PanelSection, type PanelTab } from "./atlas-panel";
import { AtlasPlace, inspectionText } from "./atlas-place";
import { AtlasSearch } from "./atlas-search";
import type { AtlasState } from "./atlas-state";
import { AtlasWrecks } from "./atlas-wrecks";
import { ChartSettingsPanel } from "./chart-settings-panel";
import type { useAtlasState } from "./use-atlas-state";

/** The dive scene, its model loader, and orbit controls load on first use. */
const WreckDive = lazy(() =>
  import("./wreck-dive").then((module) => ({ default: module.WreckDive }))
);

export interface AtlasShellHandle {
  openSettings: () => void;
}

const ZOOM_STEP = 1.35;

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
  const { scene, belonging, select } = actions;
  const wrecks = data.formerPackages ?? [];
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<PanelSection>("place");
  const [focusToken, setFocusToken] = useState(0);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const panelToggle = useRef<HTMLButtonElement>(null);
  const menuToggle = useRef<HTMLButtonElement>(null);

  const openSection = useCallback((next: PanelSection) => {
    setSection(next);
    setOpen(true);
    setFocusToken((token) => token + 1);
  }, []);
  const closePanel = useCallback(() => {
    setOpen(false);
    // On narrow screens the opening button lives in a closed menu; land on
    // the menu toggle instead of a hidden element.
    const target = trigger.current ?? panelToggle.current;
    const visible = target?.checkVisibility?.() ?? true;
    (visible ? target : menuToggle.current)?.focus();
  }, []);
  const toggleSection = useCallback(
    (next: PanelSection, element: HTMLButtonElement) => {
      trigger.current = element;
      if (open && section === next) {
        closePanel();
      } else {
        openSection(next);
      }
    },
    [open, section, closePanel, openSection]
  );
  const togglePanel = useCallback(
    (element: HTMLButtonElement) => {
      trigger.current = element;
      if (open) {
        closePanel();
      } else {
        openSection(section);
      }
    },
    [open, section, closePanel, openSection]
  );
  const openSettings = useCallback(() => {
    trigger.current = null;
    openSection("chart");
  }, [openSection]);
  useImperativeHandle(ref, () => ({ openSettings }), [openSettings]);

  useEffect(() => {
    if (!selection) {
      setEvidenceOpen(false);
    } else if (selection.symbol) {
      setEvidenceOpen(true);
      setSection("place");
      setOpen(true);
    }
  }, [selection]);
  useEffect(() => {
    if (selectedWreck) {
      setOpen(false);
    }
  }, [selectedWreck]);
  useEffect(() => {
    // Transient sections and evidence close before the map leaves a level.
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !open) {
        return;
      }
      if (section !== "place") {
        event.preventDefault();
        closePanel();
      } else if (evidenceOpen) {
        event.preventDefault();
        setEvidenceOpen(false);
      }
    };
    window.addEventListener("keydown", handleEscape, true);
    return () => window.removeEventListener("keydown", handleEscape, true);
  }, [open, section, evidenceOpen, closePanel]);

  const toggleEvidence = useCallback(
    () => setEvidenceOpen((value) => !value),
    []
  );
  const browse = useCallback(() => openSection("find"), [openSection]);
  const chooseFound = useCallback(
    (value: AtlasSelection) => {
      select(value);
      openSection("place");
    },
    [select, openSection]
  );
  const zoomOut = useCallback(
    () => scene.current?.zoom(1 / ZOOM_STEP),
    [scene]
  );
  const zoomIn = useCallback(() => scene.current?.zoom(ZOOM_STEP), [scene]);
  const wholeAtlas = useCallback(() => select(null), [select]);
  const selectWreck = useCallback(
    (wreck: FormerPackage) => actions.wreck(wreck, true),
    [actions.wreck]
  );

  const inspected = hover ?? selection;
  const inspectedRegion =
    belonging.regions.find((region) => region.id === inspected?.regionId) ??
    belonging.composites.find((region) => region.id === inspected?.compositeId);
  const readout = inspectionText(
    hoveredWreck ?? selectedWreck,
    inspected,
    inspectedRegion
  );
  const tabs: PanelTab[] = [
    {
      content: (
        <AtlasPlace
          composites={belonging.composites}
          data={data}
          error={belonging.error}
          evidence={actions}
          evidenceOpen={evidenceOpen}
          hover={hover}
          hoveredWreck={hoveredWreck}
          loading={belonging.loading}
          onBrowse={browse}
          onEvidence={toggleEvidence}
          onFrame={actions.frame}
          onRetry={belonging.retry}
          onSelect={select}
          onTrace={actions.trace}
          regions={belonging.regions}
          selection={selection}
          tracing={showConnections}
          trades={trades}
        />
      ),
      id: "place",
      label: "Place",
      persistent: true,
    },
    {
      content: (
        <AtlasSearch
          composites={belonging.composites}
          data={data}
          onSelect={chooseFound}
          regions={belonging.regions}
          selection={selection}
        />
      ),
      id: "find",
      label: "Find",
    },
    {
      content: (
        <ChartSettingsPanel
          layoutPending={
            chartSettings.coastalBuffer !== layoutSettings.coastalBuffer ||
            chartSettings.islandClearance !== layoutSettings.islandClearance
          }
          onChange={actions.settings}
          onReset={actions.reset}
          scene={scene}
          settings={chartSettings}
        />
      ),
      id: "chart",
      label: "Chart",
    },
  ];
  if (wrecks.length) {
    tabs.push({
      content: (
        <AtlasWrecks
          onSelect={selectWreck}
          selected={selectedWreck}
          wrecks={wrecks}
        />
      ),
      id: "wrecks",
      label: `Wrecks ${wrecks.length}`,
    });
  }
  return (
    <main className="atlas-shell">
      <AtlasHeader
        atmosphere={atmosphereEnabled}
        composites={belonging.composites}
        lens={lens}
        menuToggleRef={menuToggle}
        onAtmosphere={actions.atmosphere}
        onLens={actions.lens}
        onPanel={togglePanel}
        onSection={toggleSection}
        onSelect={select}
        onWholeAtlas={wholeAtlas}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        panelOpen={open}
        panelToggleRef={panelToggle}
        regions={belonging.regions}
        section={section}
        selection={selection}
      />
      <div className={open ? "atlas-world atlas-panel-open" : "atlas-world"}>
        {children}
        <AtlasPanel
          focusToken={focusToken}
          onClose={closePanel}
          onSection={setSection}
          open={open}
          section={section}
          tabs={tabs}
        />
        {selectedWreck && (
          <Suspense fallback={null}>
            <WreckDive
              onClose={actions.closeWreck}
              rendering={chartSettings.rendering}
              wreck={selectedWreck}
            />
          </Suspense>
        )}
      </div>
      <p aria-live="polite" className="sr-only" role="status">
        {readout
          ? `${readout.title} · ${readout.detail}`
          : "The archipelago · Drag to explore · Scroll to move closer · Select a territory"}
      </p>
    </main>
  );
}
