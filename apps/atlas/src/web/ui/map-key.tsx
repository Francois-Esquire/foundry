import { useCallback } from "react";
import type { ReaderSettings } from "../chart-settings";
import { filePen } from "../codex/bindings";
import type { Departures } from "../departures";
import { leastConsumers, linesPerTarget } from "../departures";
import { tiesByKind } from "../proximity";
import { crossingBead } from "../scene/ink/crossings";
import {
  closeMark,
  departureRing,
  domainMark,
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

/**
 * A departure's notched ring at 1:1, as a file's mark on the map; with
 * `explained`, its notch closed in the domain's ink, as while a domain that
 * explains it is drawn.
 */
function DepartureRingSwatch({ explained = false }: { explained?: boolean }) {
  const size = 12;
  const radius = departureRing.radius.file;
  const center = size / 2;
  const start = -Math.PI / 2 + departureRing.notch / 2;
  const end = (3 * Math.PI) / 2 - departureRing.notch / 2;
  const at = (angle: number) =>
    `${center + radius * Math.cos(angle)} ${center + radius * Math.sin(angle)}`;
  const style = inkStyle("departure");
  const plug = inkStyle("domain-explained");
  return (
    <svg
      aria-hidden="true"
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      width={size}
    >
      <path
        d={`M${at(start)} A${radius} ${radius} 0 1 1 ${at(end)}`}
        fill="none"
        stroke={swatchInk(style)}
        strokeLinecap="round"
        strokeWidth={style.weight}
      />
      {explained && (
        <path
          d={`M${at(-Math.PI / 2 - departureRing.notch / 2)} A${radius} ${radius} 0 0 1 ${at(start)}`}
          fill="none"
          stroke={swatchInk(plug)}
          strokeWidth={plug.weight}
        />
      )}
    </svg>
  );
}

/** A chosen domain's marks at 1:1: the square round a file it names, or the diamond of a package it covers whole. */
function DomainMarkSwatch({ id }: { id: "domain-file" | "domain-package" }) {
  const size = 12;
  const center = size / 2;
  const style = inkStyle(id);
  if (id === "domain-file") {
    const half = domainMark.fileSquare;
    return (
      <svg
        aria-hidden="true"
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        width={size}
      >
        <rect
          fill="none"
          height={2 * half}
          stroke={swatchInk(style)}
          strokeWidth={style.weight}
          width={2 * half}
          x={center - half}
          y={center - half}
        />
      </svg>
    );
  }
  const half = domainMark.diamond;
  return (
    <svg
      aria-hidden="true"
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      width={size}
    >
      <path
        d={`M${center} ${center - half} L${center + half} ${center} L${center} ${center + half} L${center - half} ${center} Z`}
        fill={swatchInk(style)}
      />
    </svg>
  );
}

/** The close-but-unrelated mark at 1:1, "( )": two arcs set apart. */
function ApartArcsSwatch() {
  const width = 18;
  const height = 14;
  const { apart, radius, sweep } = closeMark;
  const y = height / 2;
  const arc = (side: -1 | 1) => {
    const cx = width / 2 + side * apart;
    const facing = side < 0 ? Math.PI : 0;
    const at = (angle: number) =>
      `${cx + radius * Math.cos(angle)} ${y + radius * Math.sin(angle)}`;
    return `M${at(facing - sweep)} A${radius} ${radius} 0 0 1 ${at(facing + sweep)}`;
  };
  const style = inkStyle("proximity-close");
  return (
    <svg
      aria-hidden="true"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
    >
      <path
        d={`${arc(-1)} ${arc(1)}`}
        fill="none"
        stroke={swatchInk(style)}
        strokeLinecap="round"
        strokeWidth={style.weight}
      />
    </svg>
  );
}

/** A map key row's swatch: the arcs for a close folder, a domain's marks, a tie with its bead, or the row's line. */
function KeySwatch({ id }: { id: string }) {
  if (id === "proximity-close") {
    return <ApartArcsSwatch />;
  }
  if (id === "domain-file" || id === "domain-package") {
    return <DomainMarkSwatch id={id} />;
  }
  if (id === "domain-explained") {
    return <DepartureRingSwatch explained />;
  }
  const bead = id.startsWith("proximity-")
    ? inkStyle("proximity-bead")
    : undefined;
  return <InkSwatch bead={bead} style={inkStyle(id)} />;
}

/** What the map draws of the departures against all of them, short enough for one line. */
function departureTotals(
  departures: Pick<Departures, "lines" | "totals">
): string {
  const { candidateLines, departing, symbols } = departures.totals;
  const lines = candidateLines === 1 ? "line" : "lines";
  return `${departing} departing · ${symbols} ${symbols === 1 ? "symbol" : "symbols"} in Place · ${departures.lines.length} of ${candidateLines} ${lines}`;
}

/** The legend's short count of crossings: "2 lines between 2 workspaces". */
function crossingTotals(lines: number, workspaces: number): string {
  return `${lines} ${lines === 1 ? "line" : "lines"} between ${workspaces} workspaces`;
}

/** What the map key says of the declared domains: one line when there are none. */
function domainNote(domains: number): string {
  if (!domains) {
    return "No domains are declared.";
  }
  return `${domains} ${domains === 1 ? "domain is" : "domains are"} declared. Choose one in Find to draw it across the islands, with the domains nested in it; it stays drawn while you select places, until you clear it in Place. Its symbols are told only in Place. Place gives a place's domains and, beside a departure, its domain label: a domain departure when some consumer module shares none of its domains, or that it shares them with every consumer.`;
}

/** The rows a chosen domain draws, in the key only where domains are declared. */
const domainRows = [
  "domain-outline",
  "domain-file",
  "domain-package",
  "domain-explained",
] as const;

/** Why a departure is drawn or left out, for the map key. */
function departureRules(dominantShare: number): string {
  return `A place departs when one other package holds at least ${Math.round(dominantShare * 100)}% of the modules that use it, its own package counted as one. A line is drawn when it rests on at least ${leastConsumers} of those modules, and at most ${linesPerTarget} run into one package; the totals count every departure. Consumers in no package of the scan are not counted.`;
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
  ["folder-cell", null],
  ["proximity-apart", null],
  ["proximity-co-change", null],
  ["proximity-close", null],
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
  crossings,
  departures,
  domains,
  onHeight,
  settings,
}: {
  /** In a collection, the crossing lines drawn and the workspaces they join; none for a single workspace. */
  crossings?: { lines: number; workspaces: number };
  /** How many domains the workspace declares. */
  domains: number;
  /** The departures the map draws, for their row and totals. */
  departures: Pick<Departures, "dominantShare" | "lines" | "totals">;
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
      {departures.totals.departing > 0 && (
        <ul className="atlas-legend-row">
          <li>
            <DepartureRingSwatch />
            {inkStyle("departure").meaning}
          </li>
          <li>
            <InkSwatch
              bead={inkStyle("departure-bead")}
              style={inkStyle("departure-line")}
            />
            {inkStyle("departure-line").meaning}
          </li>
          <li className="atlas-legend-totals">{departureTotals(departures)}</li>
        </ul>
      )}
      {crossings && crossings.lines > 0 && (
        <ul className="atlas-legend-row">
          <li>
            <InkSwatch
              bead={inkStyle("crossing-bead")}
              beadRadius={crossingBead}
              style={inkStyle("crossing")}
            />
            {inkStyle("crossing").meaning}
          </li>
          <li className="atlas-legend-totals">
            {crossingTotals(crossings.lines, crossings.workspaces)}
          </li>
        </ul>
      )}
      <details className="atlas-map-key">
        <summary>Map key</summary>
        <dl>
          {keyRows.map(([id, setting]) => {
            const style = inkStyle(id);
            return (
              <div key={id}>
                <dt>
                  <KeySwatch id={id} />
                  {style.meaning}
                  {setting && !settings[setting] && " · off"}
                </dt>
              </div>
            );
          })}
          {domains > 0 &&
            domainRows.map((id) => (
              <div key={id}>
                <dt>
                  <KeySwatch id={id} />
                  {inkStyle(id).meaning}
                </dt>
              </div>
            ))}
        </dl>
        {departures.totals.departing > 0 && (
          <p>{departureRules(departures.dominantShare)}</p>
        )}
        <p>
          Closer in, proximity: a dotted tie from a file to its responsibility's
          folder when it sits apart, a dashed tie between two files in different
          folders that change together, and two arcs set apart on a folder whose
          files serve unrelated responsibilities. An island shows its{" "}
          {tiesByKind["co-change"]} strongest co-change ties and{" "}
          {tiesByKind.apart} apart ties, one kind making up for the other when
          it runs short, or all of a selected file's; Place counts them and
          lists the rest, and co-changes across packages.
        </p>
        <p>
          Closer in, an island's folders: a faint line between sibling folders,
          and their names in italics ending in a slash ("web/"), apart from a
          district's name. Place names a file's path region, and an island's
          path regions and the seams between them, the imports from one region
          into another.
        </p>
        {crossings && crossings.lines > 0 && (
          <p>
            Between workspaces, crossings: a package's declared dependencies on
            packages of another workspace, one line for each pair of packages,
            ending in a bead at the package depended on. They are drawn over the
            sea between the frames, under departures and the selection; with an
            island selected, only its own stay. Place lists them. They are not
            routes: no imports are recorded across workspaces.
          </p>
        )}
        <p>{domainNote(domains)}</p>
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
