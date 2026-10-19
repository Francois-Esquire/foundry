import { filePen } from "../data/bindings";
import { fileInk } from "../ladder/ink-ladder";
import { type InkStyle, inkStyle, swatchInk } from "../ladder/ink-table";
import type { ReaderSettings } from "../settings/chart-settings";

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
const marks = [
  "selection",
  "selection-imports",
  "selection-importers",
  "coast",
  "departure",
  "departure-line",
  "crossing",
  "folder-cell",
  "proximity-apart",
  "proximity-co-change",
  "proximity-close",
  "trade",
  "stream",
  "marsh-drain",
  "unresolved-outline",
  "land-contour",
  "sea-contour",
] as const;

/** The renderer's ink key, available only inside the Legend sheet. */
export function MapKey({ settings }: { settings: ReaderSettings }) {
  return (
    <section aria-label="Map legend" className="spyglass-map-key">
      <p>Connected packages draw together. File clusters form the islands.</p>
      <ul className="spyglass-file-key">
        {fileKinds.map((kind) => (
          <li key={kind}>
            <FileSwatch kind={kind} />
            {kind}
          </li>
        ))}
      </ul>
      <dl>
        {marks.map((id) => (
          <div key={id}>
            <dt>
              <InkSwatch style={inkStyle(id)} />
            </dt>
            <dd>{inkStyle(id).meaning}</dd>
          </div>
        ))}
      </dl>
      <p>
        Height follows internal file usage. Sea washes show distance from shore.
      </p>
      <p>
        Sea trade routes {settings.trade ? "on" : "off"} · District streams{" "}
        {settings.streams ? "on" : "off"} · Topographic lines{" "}
        {settings.contours ? "on" : "off"}
      </p>
    </section>
  );
}
