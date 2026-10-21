import type { CliRenderer, StyledText as StyledTextType } from "@opentui/core";
import {
  BoxRenderable,
  bold,
  createCliRenderer,
  cyan,
  dim,
  green,
  red,
  StyledText,
  stringToStyledText,
  TextRenderable,
  yellow,
} from "@opentui/core";
import type {
  PhaseRecord,
  ProgressSnapshot,
  UnitRecord,
  UnitsProgress,
} from "./progress";
import { formatDuration } from "./progress";

// The live display of a scan in a terminal, drawn with OpenTUI on stderr in
// the terminal's footer rows so stdout stays the command's result and the
// scrollback above keeps scrolling. `mountLoader` draws a snapshot onto any
// renderer, the test renderer included; `createLoader` owns the terminal's.

export interface LoaderOptions {
  /** `false` under `NO_COLOR`: the same text without attributes. */
  readonly color: boolean;
  /** Two rows (`open`, which heads to the browser) rather than the full panel. */
  readonly compact: boolean;
}

export interface Loader {
  /** Tears the display down and returns the terminal; safe to call twice. */
  finish(): void;
  update(snapshot: ProgressSnapshot): void;
}

/** The rows the display takes at the bottom of the terminal. */
const COMPACT_ROWS = 2;
export const FULL_ROWS = 8;
const loaderRows = (compact: boolean): number =>
  compact ? COMPACT_ROWS : FULL_ROWS;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BAR_WIDTH = 24;
const TICK_MS = 100;

type Style = "accent" | "bad" | "dim" | "good" | "plain" | "strong" | "warn";
interface Segment {
  readonly style: Style;
  readonly text: string;
}
const seg = (style: Style, text: string): Segment => ({ style, text });
const plain = (text: string): Segment => seg("plain", text);

const STYLERS: Record<Style, (text: string) => StyledTextType["chunks"]> = {
  accent: (text) => [cyan(text)],
  bad: (text) => [red(text)],
  dim: (text) => [dim(text)],
  good: (text) => [green(text)],
  plain: (text) => stringToStyledText(text).chunks,
  strong: (text) => [bold(text)],
  warn: (text) => [yellow(text)],
};

/** Segments to one row's content, cut to the width; no attributes without colour. */
function row(
  segments: readonly Segment[],
  width: number,
  color: boolean
): StyledTextType | string {
  let remaining = Math.max(0, width);
  const cut: Segment[] = [];
  for (const segment of segments) {
    if (remaining <= 0) {
      break;
    }
    const text = [...segment.text].slice(0, remaining).join("");
    remaining -= [...text].length;
    cut.push({ ...segment, text });
  }
  if (!color) {
    return cut.map((segment) => segment.text).join("");
  }
  return new StyledText(
    cut.flatMap((segment) => STYLERS[segment.style](segment.text))
  );
}

const PHASE_LABEL: Record<string, string> = {
  analyze: "analyzing packages",
  derive: "deriving the workspace",
  discover: "discovering packages",
  fingerprint: "fingerprinting",
  ingest: "ingesting",
  intelligence: "workspace intelligence",
  lenses: "writing lenses",
  project: "projecting",
  write: "writing the dataset",
};

const currentPhase = (
  phases: readonly PhaseRecord[]
): PhaseRecord | undefined => phases.at(-1);

/** ` 7 of 16` while packages or internals are counted; nothing otherwise. */
function counted({ internals, phases, units }: ProgressSnapshot): string {
  if (internals !== undefined) {
    return ` ${internals.index} of ${internals.total}`;
  }
  if (currentPhase(phases)?.name === "analyze" && units.total > 0) {
    return ` ${units.done} of ${units.total}`;
  }
  return "";
}

/** `⠋ Scanning foundry · analyzing packages 7 of 16 · 12s` */
function headline(
  snapshot: ProgressSnapshot,
  now: number,
  tick: number
): Segment[] {
  const phase = currentPhase(snapshot.phases);
  const where = snapshot.workspace
    ? ` ${snapshot.workspace.split("/").filter(Boolean).at(-1) ?? ""}`
    : "";
  const doing =
    phase === undefined ? "starting" : (PHASE_LABEL[phase.name] ?? phase.name);
  const count = counted(snapshot);
  return [
    seg("accent", SPINNER[tick % SPINNER.length] ?? SPINNER[0] ?? "-"),
    plain(" "),
    seg("strong", `Scanning${where}`),
    seg("dim", " · "),
    plain(doing),
    seg("accent", count),
    seg("dim", ` · ${formatDuration(now - snapshot.startedAt)}`),
  ];
}

/** `✓ discover 0.1s  ✓ fingerprint 0.3s  ● analyze` */
function trail(phases: readonly PhaseRecord[], now: number): Segment[] {
  const segments: Segment[] = [];
  for (const phase of phases) {
    if (segments.length > 0) {
      segments.push(plain("  "));
    }
    if (phase.durationMs === undefined) {
      segments.push(seg("accent", "● "), seg("strong", phase.name));
      segments.push(seg("dim", ` ${formatDuration(now - phase.startedAt)}`));
    } else {
      segments.push(
        seg("good", "✓ "),
        plain(phase.name),
        seg("dim", ` ${formatDuration(phase.durationMs)}`)
      );
    }
  }
  return segments;
}

function bar(done: number, total: number): Segment[] {
  const filled =
    total > 0 ? Math.round((Math.min(done, total) / total) * BAR_WIDTH) : 0;
  return [
    seg("accent", "█".repeat(filled)),
    seg("dim", "░".repeat(BAR_WIDTH - filled)),
  ];
}

/** The bar row: packages analyzed, or internals derived, or the phase's detail. */
function gauge(snapshot: ProgressSnapshot): Segment[] {
  const { internals, units, plan } = snapshot;
  const phase = currentPhase(snapshot.phases);
  if (internals !== undefined) {
    return [
      ...bar(internals.index - 1, internals.total),
      plain(` ${internals.index}/${internals.total} internals `),
      seg("accent", internals.package),
    ];
  }
  if (units.total > 0) {
    const counts = [
      seg("good", `${units.analyzed} analyzed`),
      seg("dim", " · "),
      plain(`${units.reused} reused`),
      ...(units.failed > 0
        ? [seg("dim", " · "), seg("bad", `${units.failed} failed`)]
        : []),
    ];
    return [
      ...bar(units.done, units.total),
      plain(` ${units.done}/${units.total}  `),
      ...counts,
    ];
  }
  if (plan !== undefined) {
    return [
      seg("dim", "plan: "),
      plain(`${plan.recompute} to analyze, ${plan.reuse} to reuse`),
    ];
  }
  return phase?.detail ? [seg("dim", phase.detail)] : [];
}

const UNIT_MARK: Record<UnitRecord["status"], Segment> = {
  complete: seg("good", "✓"),
  failed: seg("bad", "✗"),
  reused: seg("dim", "↺"),
  started: seg("accent", "▸"),
};

/** One row per package being analyzed, then the latest finished, newest first. */
function packageRows(
  units: UnitsProgress,
  now: number,
  rows: number
): Segment[][] {
  const active = units.active.map(({ unit, startedAt }) => [
    plain("  "),
    UNIT_MARK.started,
    plain(` ${unit} `),
    seg("dim", `analyzing ${formatDuration(now - startedAt)}`),
  ]);
  const recent = units.recent.map((record) => [
    plain("  "),
    UNIT_MARK[record.status],
    plain(` ${record.unit} `),
    record.status === "failed"
      ? seg("bad", record.error ?? "failed")
      : seg(
          "dim",
          record.status === "reused"
            ? "reused"
            : formatDuration(record.durationMs)
        ),
  ]);
  return [...active, ...recent].slice(0, rows);
}

function historyRow(snapshot: ProgressSnapshot): Segment[] {
  const { history } = snapshot;
  if (history === undefined) {
    return [];
  }
  const phase = currentPhase(history.phases);
  const { checkpoints } = history;
  return [
    seg("dim", "history · "),
    plain(phase?.name ?? "starting"),
    ...(checkpoints.total > 0
      ? [
          seg("dim", " · checkpoints "),
          plain(`${checkpoints.done}/${checkpoints.total}`),
          ...(checkpoints.cached > 0
            ? [seg("dim", ` (${checkpoints.cached} cached)`)]
            : []),
        ]
      : []),
  ];
}

/** The rows of the display for one moment, top to bottom. */
export function layout(
  snapshot: ProgressSnapshot,
  options: LoaderOptions,
  now: number,
  tick: number
): Segment[][] {
  const rows = loaderRows(options.compact);
  if (options.compact) {
    return [headline(snapshot, now, tick), gauge(snapshot)];
  }
  const fixed = [
    headline(snapshot, now, tick),
    trail(snapshot.phases, now),
    gauge(snapshot),
  ];
  const history = historyRow(snapshot);
  const tail = history.length > 0 ? [history] : [];
  const packages = packageRows(
    snapshot.units,
    now,
    rows - fixed.length - tail.length
  );
  const lines = [...fixed, ...packages, ...tail];
  while (lines.length < rows) {
    lines.splice(fixed.length + packages.length, 0, []);
  }
  return lines;
}

export interface MountedLoader {
  draw(snapshot: ProgressSnapshot, now: number, tick: number): void;
}

/** Mounts the rows onto a renderer's root; `draw` repaints them from a snapshot. */
export function mountLoader(
  renderer: CliRenderer,
  options: LoaderOptions
): MountedLoader {
  const box = new BoxRenderable(renderer, {
    flexDirection: "column",
    height: loaderRows(options.compact),
    id: "spyglass-loader",
    width: "100%",
  });
  const lines = Array.from(
    { length: loaderRows(options.compact) },
    (_, index) =>
      new TextRenderable(renderer, {
        content: "",
        height: 1,
        id: `spyglass-loader-${index}`,
        wrapMode: "none",
      })
  );
  for (const line of lines) {
    box.add(line);
  }
  renderer.root.add(box);
  return {
    draw(snapshot, now, tick) {
      const rows = layout(snapshot, options, now, tick);
      lines.forEach((line, index) => {
        line.content = row(rows[index] ?? [], renderer.width, options.color);
      });
      renderer.requestRender();
    },
  };
}

/**
 * The terminal's loader: a split-footer renderer on stderr that takes no
 * mouse and no exit on Ctrl-C of its own. Raw mode swallows the terminal's
 * Ctrl-C, so the key is read and SIGINT raised by hand once the display is
 * gone, and SIGTERM is caught to leave the terminal sane before re-raising.
 */
export async function createLoader(options: LoaderOptions): Promise<Loader> {
  const renderer = await createCliRenderer({
    clearOnShutdown: false,
    exitOnCtrlC: false,
    exitSignals: [],
    externalOutputMode: "passthrough",
    footerHeight: loaderRows(options.compact),
    screenMode: "split-footer",
    stdin: process.stdin,
    stdout: process.stderr,
    useMouse: false,
  });
  const mounted = mountLoader(renderer, options);
  let latest: ProgressSnapshot | undefined;
  let tick = 0;
  let finished = false;
  const repaint = () => {
    if (latest !== undefined) {
      mounted.draw(latest, performance.now(), tick);
    }
  };
  const ticker = setInterval(() => {
    tick += 1;
    repaint();
  }, TICK_MS);
  const finish = () => {
    if (finished) {
      return;
    }
    finished = true;
    clearInterval(ticker);
    process.removeListener("SIGTERM", onTerm);
    renderer.destroy();
  };
  const raise = (signal: NodeJS.Signals) => {
    finish();
    process.kill(process.pid, signal);
  };
  const onTerm = () => raise("SIGTERM");
  process.once("SIGTERM", onTerm);
  renderer.keyInput.on("keypress", (key) => {
    if (key.ctrl && key.name === "c") {
      raise("SIGINT");
    }
  });
  return {
    finish,
    update(snapshot) {
      latest = snapshot;
      repaint();
    },
  };
}
