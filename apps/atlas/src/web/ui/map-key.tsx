import { useCallback } from "react";
import type { ReaderSettings } from "../chart-settings";
import { filePen } from "../codex/bindings";
import {
  fileInk,
  type InkStyle,
  inkStyle,
  swatchInk,
} from "../scene/ink-ladder";

/** A swatch's size in CSS pixels; its viewBox is the same, so every unit is a pixel. */
const swatch = { height: 14, width: 30 } as const;

/**
 * One row of the ink table at 1:1, as the map draws it on screen: the same
 * weight and dash in pixels (a row in map units at one pixel per unit, as at
 * overview).
 */
function InkSwatch({ style }: { style: InkStyle }) {
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

const fileKinds = [
  ["source", "Source"],
  ["test", "Test"],
  ["story", "Story"],
  ["config", "Config"],
  ["other", "Other"],
] as const;

/** The lines a reader always reads by: the selection, its dependencies, and the coast. */
const legendLines = [
  ["selection", "Selected"],
  ["selection-imports", "Imports from"],
  ["selection-importers", "Imported by"],
  ["coast", "Package coast"],
] as const;

/**
 * The reader layers the map key explains, each with the setting that turns
 * it on; a row without one is drawn whenever its island is entered.
 */
const keyRows: readonly [string, keyof ReaderSettings | null][] = [
  ["trade", "trade"],
  ["stream", "streams"],
  ["marsh-drain", null],
  ["unresolved-outline", null],
  ["land-contour", "contours"],
  ["sea-contour", "contours"],
];

/**
 * The always-visible legend in the lower right, two rows (where north
 * points, and the file kinds; then the lines a reader reads by), above the
 * collapsed map key, which explains each reader layer. Both read the ink
 * ladder's table, so the key draws every line as the map does.
 */
export function MapKey({
  onHeight,
  settings,
}: {
  /** Called with the legend's height in CSS pixels whenever it changes, so margin notes clear it. */
  onHeight: (height: number) => void;
  settings: ReaderSettings;
}) {
  const observeLegend = useCallback(
    (element: HTMLElement | null) => {
      if (!(element && "ResizeObserver" in window)) {
        return;
      }
      const observer = new ResizeObserver(() => {
        onHeight(element.getBoundingClientRect().height);
      });
      observer.observe(element);
      return () => observer.disconnect();
    },
    [onHeight]
  );
  return (
    <aside aria-label="Legend" className="atlas-legend" ref={observeLegend}>
      <ul className="atlas-legend-row">
        <li>
          <span aria-hidden="true" className="atlas-legend-north">
            N
          </span>
          Packages built on others north, the foundation south
        </li>
        {fileKinds.map(([kind, label]) => (
          <li key={kind}>
            <FileSwatch kind={kind} />
            {label}
          </li>
        ))}
      </ul>
      <ul className="atlas-legend-row">
        {legendLines.map(([id, label]) => (
          <li key={id}>
            <InkSwatch style={inkStyle(id)} />
            {label}
          </li>
        ))}
      </ul>
      <details className="atlas-map-key">
        <summary>Map key</summary>
        <dl>
          {keyRows.map(([id, setting]) => {
            const style = inkStyle(id);
            return (
              <div key={id}>
                <dt>
                  <InkSwatch style={style} />
                  {style.meaning}
                  {setting && !settings[setting] && " · off"}
                </dt>
              </div>
            );
          })}
        </dl>
        <p>
          Islands are low ground. Only a package's high fan-in files raise
          rounded summits: those that at least its cutoff of the package's own
          source files import. Relief is capped so it never reads darker than a
          file mark; most slopes stay well under that cap. Height is not a
          quality score. Commons and composition junctions are identified in
          Place.
          {settings.volcanic
            ? " Recorded Git change counts and dates are in Place."
            : " Recorded change is off."}
        </p>
      </details>
    </aside>
  );
}
