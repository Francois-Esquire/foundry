import type { ChangeEvent, MouseEvent, Ref } from "react";
import { useCallback, useState } from "react";
import type { BelongingRegion } from "../belonging";
import type { AtlasSelection } from "../scene/scene";
import type { PanelSection } from "./atlas-panel";

export type Lens = "belonging" | "files";

/** Breadcrumb, map layer, and every control that used to sit in the footer. */
export function AtlasHeader({
  selection,
  regions,
  composites,
  lens,
  atmosphere,
  panelOpen,
  section,
  panelToggleRef,
  menuToggleRef,
  onLens,
  onSelect,
  onSection,
  onPanel,
  onZoomIn,
  onZoomOut,
  onWholeAtlas,
  onAtmosphere,
}: {
  selection: AtlasSelection | null;
  regions: BelongingRegion[];
  composites: BelongingRegion[];
  lens: Lens;
  atmosphere: boolean;
  panelOpen: boolean;
  section: PanelSection;
  panelToggleRef: Ref<HTMLButtonElement>;
  menuToggleRef: Ref<HTMLButtonElement>;
  onLens: (lens: Lens) => void;
  onSelect: (value: AtlasSelection | null) => void;
  onSection: (section: PanelSection, trigger: HTMLButtonElement) => void;
  onPanel: (trigger: HTMLButtonElement) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onWholeAtlas: () => void;
  onAtmosphere: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const territory = selection?.territory;
  const region = regions.find((item) => item.id === selection?.regionId);
  const composite = composites.find(
    (item) => item.id === selection?.compositeId
  );
  const handleLens = useCallback(
    (event: ChangeEvent<HTMLSelectElement, HTMLSelectElement>) => {
      onLens(event.target.value === "files" ? "files" : "belonging");
    },
    [onLens]
  );
  const toggleMenu = useCallback(() => setMenuOpen((open) => !open), []);
  const openSection = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const { value } = event.currentTarget;
      if (value === "find" || value === "chart") {
        onSection(value, event.currentTarget);
        setMenuOpen(false);
      }
    },
    [onSection]
  );
  const togglePanel = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      onPanel(event.currentTarget);
      setMenuOpen(false);
    },
    [onPanel]
  );
  const crumbAtlas = useCallback(() => onSelect(null), [onSelect]);
  const crumbTerritory = useCallback(() => {
    if (territory) {
      onSelect({ territory });
    }
  }, [onSelect, territory]);
  const crumbComposite = useCallback(() => {
    if (territory && composite) {
      onSelect({ compositeId: composite.id, territory });
    }
  }, [onSelect, composite, territory]);
  const crumbRegion = useCallback(() => {
    if (territory && region) {
      onSelect({ compositeId: composite?.id, regionId: region.id, territory });
    }
  }, [onSelect, composite, region, territory]);
  return (
    <header className="atlas-header">
      <nav aria-label="Atlas breadcrumb" className="atlas-breadcrumb">
        <button onClick={crumbAtlas} type="button">
          Atlas
        </button>
        {territory && (
          <Crumb label={territory.label} onClick={crumbTerritory} />
        )}
        {composite && (
          <Crumb label={composite.label} onClick={crumbComposite} />
        )}
        {region && <Crumb label={region.label} onClick={crumbRegion} />}
        {selection?.file && (
          <>
            <span aria-hidden="true">/</span>
            <span aria-current="location">
              {selection.file.path.split("/").at(-1)}
            </span>
          </>
        )}
      </nav>
      <button
        aria-controls="atlas-header-tools"
        aria-expanded={menuOpen}
        className="atlas-menu-toggle"
        onClick={toggleMenu}
        ref={menuToggleRef}
        type="button"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
        <span className="sr-only">Menu</span>
      </button>
      <div
        className="atlas-header-tools"
        data-open={menuOpen}
        id="atlas-header-tools"
      >
        <label className="atlas-lens">
          <span className="sr-only">Map layer</span>
          <select aria-label="Map layer" onChange={handleLens} value={lens}>
            <option value="belonging">Belonging</option>
            <option value="files">Files</option>
          </select>
        </label>
        <button
          aria-controls="atlas-panel"
          aria-expanded={panelOpen && section === "find"}
          className="atlas-find"
          onClick={openSection}
          type="button"
          value="find"
        >
          Find a place
        </button>
        <fieldset aria-label="Map controls" className="atlas-controls">
          <button onClick={onZoomOut} title="Zoom out" type="button">
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M5 12h14" />
            </svg>
            <span className="atlas-control-label">Zoom out</span>
          </button>
          <button onClick={onWholeAtlas} title="Whole atlas" type="button">
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4" />
            </svg>
            <span className="atlas-control-label">Whole atlas</span>
          </button>
          <button onClick={onZoomIn} title="Zoom in" type="button">
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M5 12h14M12 5v14" />
            </svg>
            <span className="atlas-control-label">Zoom in</span>
          </button>
          <button
            aria-pressed={atmosphere}
            onClick={onAtmosphere}
            title="Dependency currents, wind and coastlight"
            type="button"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M3 8h12c5 0 5-6 1-6M3 12h16c4 0 4 6 0 6M3 16h6c4 0 4 5 1 5" />
            </svg>
            <span className="atlas-control-label">Decorative atmosphere</span>
          </button>
          <button
            aria-controls="atlas-panel"
            aria-expanded={panelOpen && section === "chart"}
            onClick={openSection}
            title="Chart settings and playback"
            type="button"
            value="chart"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="9" />
              <path d="m16 8-2.5 5.5L8 16l2.5-5.5Z" />
            </svg>
            <span className="atlas-control-label">Chart settings</span>
          </button>
          <button
            aria-controls="atlas-panel"
            aria-expanded={panelOpen}
            onClick={togglePanel}
            ref={panelToggleRef}
            title="Side panel"
            type="button"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <rect height="16" width="18" x="3" y="4" />
              <path d="M15 4v16" />
            </svg>
            <span className="atlas-control-label">Side panel</span>
          </button>
        </fieldset>
      </div>
    </header>
  );
}

function Crumb({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <>
      <span aria-hidden="true">/</span>
      <button onClick={onClick} type="button">
        {label}
      </button>
    </>
  );
}
