import { filePen } from "../data/bindings";
import { fileInk } from "../ladder/ink-ladder";
import {
  type InkId,
  type InkStyle,
  inkStyle,
  swatchInk,
} from "../ladder/ink-table";
import {
  isSceneLayerVisible,
  type SceneLayerId,
} from "../settings/scene-composition";
import type { SpyglassState } from "./spyglass-state";

/** A swatch's size in CSS pixels; its viewBox is the same, so every unit is a pixel. */
const swatch = { height: 14, width: 30 } as const;

/**
 * One row of the ink table at 1:1, as the map draws it on screen: the same
 * weight and dash in pixels (a row in map units at one pixel per unit, as at
 * overview).
 */
function InkSwatch({
  bead,
  beadRadius = 2.2,
  style,
}: {
  bead?: InkStyle;
  /** The bead's radius in screen pixels, as the map draws it. */
  beadRadius?: number;
  style: InkStyle;
}) {
  const { height, width } = swatch;
  const view = `0 0 ${width} ${height}`;
  if (style.kind === "text") {
    return (
      <svg aria-hidden="true" height={height} viewBox={view} width={width}>
        <text fill={swatchInk(style)} fontSize="11" x="6" y="11">
          Aa
        </text>
      </svg>
    );
  }
  const dotted = (style.dash[0] ?? 1) < 1;
  return (
    <svg aria-hidden="true" height={height} viewBox={view} width={width}>
      <path
        d={`M3 ${height / 2} H${width - 3}`}
        fill="none"
        stroke={swatchInk(style)}
        strokeDasharray={style.dash.join(" ") || undefined}
        strokeLinecap={dotted ? "round" : "butt"}
        strokeWidth={style.weight}
      />
      {bead && (
        <circle
          cx={width - 3}
          cy={height / 2}
          fill={swatchInk(bead)}
          r={beadRadius}
        />
      )}
    </svg>
  );
}

/** A file mark's size on screen at close zoom: `filePen` at ten pixels per unit. */
const markSize = filePen(10) * 10;

/**
 * One file kind's mark at 1:1, in the shape and ink the map gives it close
 * in: an upright block for source, config, and other; an open box with a
 * foot for test; a half-disc for story. At overview every file is a dot.
 */
function FileSwatch({ kind }: { kind: string }) {
  const size = 10;
  const ink = fileInk(kind);
  const half = markSize / 2;
  const center = { x: size / 2, y: size / 2 - half / 2 };
  let mark = (
    <rect
      fill={ink}
      height={markSize * 1.5}
      width={markSize}
      x={center.x - half}
      y={center.y - half}
    />
  );
  if (kind === "test") {
    mark = (
      <>
        <rect
          fill="none"
          height={markSize * 1.5}
          stroke={ink}
          strokeWidth="1"
          width={markSize}
          x={center.x - half}
          y={center.y - half}
        />
        <rect
          fill={ink}
          height={half}
          width={half}
          x={center.x - half / 2}
          y={center.y}
        />
      </>
    );
  } else if (kind === "story") {
    mark = (
      <path
        d={`M${center.x + markSize} ${center.y} A${markSize} ${markSize} 0 0 1 ${center.x - markSize} ${center.y} Z`}
        fill={ink}
      />
    );
  }
  return (
    <svg
      aria-hidden="true"
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      width={size}
    >
      {mark}
    </svg>
  );
}

const fileKinds = ["source", "test", "story", "config", "other"] as const;

type LegendState = Pick<
  SpyglassState,
  | "belongingLayer"
  | "chartSettings"
  | "data"
  | "domain"
  | "mapLayer"
  | "responsibility"
  | "selection"
  | "showConnections"
>;

function InkRow({ id, meaning }: { id: InkId; meaning?: string }) {
  const style = inkStyle(id);
  return (
    <div data-ink={id}>
      <dt>
        <InkSwatch style={style} />
      </dt>
      <dd>{meaning ?? style.meaning}</dd>
    </div>
  );
}

/** These are enabled meanings, rather than a catalogue of every possible mark. */
function enabledDetails(state: LegendState): InkId[] {
  const { chartSettings: settings, selection } = state;
  const visible = (id: SceneLayerId) =>
    isSceneLayerVisible(settings.composition, id);
  const belonging =
    state.mapLayer === "belonging" &&
    state.belongingLayer !== null &&
    visible("belonging");
  const entries: { enabled: boolean; ids: InkId[] }[] = [
    { enabled: visible("folders"), ids: ["folder-cell"] },
    {
      enabled: belonging,
      ids: ["responsibility-outline", "unresolved-outline"],
    },
    { enabled: belonging && settings.streams, ids: ["stream", "marsh-drain"] },
    { enabled: settings.trade && visible("trades"), ids: ["trade"] },
    {
      enabled: settings.contours && visible("topography"),
      ids: ["land-contour", "sea-contour"],
    },
    { enabled: !!state.domain && visible("domain"), ids: ["domain-outline"] },
    {
      enabled: !!state.responsibility && visible("responsibility"),
      ids: ["inspection-focus", "inspection-link"],
    },
    {
      enabled: visible("departures"),
      ids: selection ? ["departure"] : ["departure", "departure-line"],
    },
    {
      enabled: visible("crossings") && !!state.data.crossings?.length,
      ids: ["crossing"],
    },
    {
      enabled: visible("proximity") && !!selection,
      ids: ["proximity-apart", "proximity-co-change", "proximity-close"],
    },
  ];
  return entries.filter(({ enabled }) => enabled).flatMap(({ ids }) => ids);
}

function OceanKey({ state }: { state: LegendState }) {
  const settings = state.chartSettings;
  const visible = (id: SceneLayerId) =>
    isSceneLayerVisible(settings.composition, id);
  const islands = visible("relief") || visible("ground");
  return (
    <>
      {" "}
      {visible("sea") && visible("ocean-depth") && (
        <p className="spyglass-map-key-note">
          Water shading follows distance from shore.
        </p>
      )}
      {settings.clouds &&
        visible("subsurface-drift") &&
        (visible("sea") || islands) && (
          <p className="spyglass-map-key-note">
            Subsurface drift is decorative light and shade.
          </p>
        )}
    </>
  );
}

/** The legend explains the current composition without becoming another control panel. */
export function MapKey({ state }: { state: LegendState }) {
  const { chartSettings: settings, selection } = state;
  const visible = (id: SceneLayerId) =>
    isSceneLayerVisible(settings.composition, id);
  const islands = visible("coast") || visible("relief") || visible("cliffs");
  const files = visible("files");
  const architecture = settings.presentation > 0 && visible("architecture");
  const dependencies =
    visible("dependency-routes") ||
    (visible("connections") &&
      state.showConnections &&
      !!selection?.fileId &&
      !state.responsibility);
  const selected =
    !!selection &&
    (visible("selection") ||
      (selection.fileId && visible("dependency-routes")));
  const details = enabledDetails(state);
  return (
    <section aria-label="Map legend" className="spyglass-map-key">
      <h2>Reading this map</h2>
      {islands && (
        <p>
          <strong>Islands are packages.</strong> Their files shape the
          coastline. Connected packages draw together.
        </p>
      )}
      {files && (
        <p>
          <strong>Marks are files.</strong> Move closer to see their kinds and
          local relationships.
        </p>
      )}
      {dependencies && (
        <p>
          <strong>
            Dependencies run from a consumer to the file it imports.
          </strong>{" "}
          Arrowheads point to the imported file. Local routes appear as you move
          closer; selecting a file focuses its relationships.
        </p>
      )}
      {!(islands || files || dependencies || architecture) && (
        <p>
          The current view isolates the environment. Package and file meanings
          return when those layers are shown.
        </p>
      )}
      {architecture && (
        <p>
          <strong>Buildings represent files.</strong> Taller buildings have more
          incoming module imports. Copper roofs identify files used by another
          package. Small buildings appear as you move closer.
        </p>
      )}
      {selected && (
        <dl aria-label="Selection meanings">
          {visible("selection") && (
            <InkRow id="selection" meaning="Your selected package or file" />
          )}
          <InkRow
            id="selection-imports"
            meaning="Dashed: the selection imports this package or file"
          />
          <InkRow
            id="selection-importers"
            meaning="Dotted: this package or file imports the selection"
          />
        </dl>
      )}
      {(files || details.length > 0) && (
        <details className="spyglass-map-key-details">
          <summary>Enabled map details</summary>
          <p>Finer marks appear as you move closer or select a place.</p>
          {files && (
            <ul aria-label="File kinds" className="spyglass-file-key">
              {fileKinds.map((kind) => (
                <li key={kind}>
                  <FileSwatch kind={kind} />
                  {kind}
                </li>
              ))}
            </ul>
          )}
          {details.length > 0 && (
            <dl>
              {details.map((id) => (
                <InkRow id={id} key={id} />
              ))}
            </dl>
          )}
        </details>
      )}
      <OceanKey state={state} />
    </section>
  );
}
