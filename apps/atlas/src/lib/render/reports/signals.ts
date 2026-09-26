import type {
  ArchitecturalTension,
  BoundaryPressureSignal,
  PressureEvidence,
  StructuralPressureSignal,
  SurfaceReport,
} from "../../types";
import type { RenderDensity } from "../context";
import { evidenceLine, metricValue, percent, plural } from "../format";
import type { BlockView } from "../views";

/**
 * Signals fire from a handful of measurements, so several often say the
 * same thing. One group per measurement family carries every name that
 * fired and one sentence composed from the numbers those names share.
 */
interface SignalGroup {
  /** One line per distinct fact; pressure and history facts live here. */
  facts: string[];
  names: string[];
  /** Raw metric lines, shown only at expanded density. */
  raw: string[];
  summary?: string;
}

const CONSUMPTION = new Set([
  "single-consumer",
  "concentrated-consumption",
  "distributed-consumption",
  "one-way-satellite",
  "shared-hub",
  "shared-hub-like",
  "narrowly-consumed",
  "broadly-consumed",
]);

const GRAVITY = new Set([
  "high-fan-in",
  "high-fan-out",
  "foundation-like",
  "integration-like",
  "leaf-like",
]);

export function signalBlocks(
  report: SurfaceReport,
  density: RenderDensity
): BlockView[] {
  const groups = [
    consumption(report),
    gravity(report),
    surface(report),
    pressure(report),
    history(report),
  ].filter((group) => group.names.length > 0);
  return groups.map((group) => ({
    kind: "signal",
    title: group.names.join(" · "),
    tone: "neutral",
    ...(density !== "compact" && {
      ...(group.summary !== undefined && { summary: group.summary }),
      evidence: [...group.facts, ...(density === "expanded" ? group.raw : [])],
    }),
  }));
}

/** Every signal name a group carries, for definition lookup. */
export function signalNames(report: SurfaceReport): string[] {
  return signalBlocks(report, "compact").flatMap((block) =>
    block.kind === "signal" ? block.title.split(" · ") : []
  );
}

function profileNames(report: SurfaceReport, family: Set<string>): string[] {
  return [
    ...report.dependencies.shapeSignals.filter((name) => family.has(name)),
    ...report.architecturalProfile.target.signals
      .map((result) => result.signal)
      .filter((name) => family.has(name)),
  ];
}

function profileRaw(report: SurfaceReport, family: Set<string>): string[] {
  return report.architecturalProfile.target.signals
    .filter((result) => family.has(result.signal))
    .map(
      (result) =>
        `${result.signal}: ${result.evidence
          .map((entry) => evidenceLine(entry.metric, entry.value))
          .join(" · ")}`
    );
}

function consumption(report: SurfaceReport): SignalGroup {
  const names = profileNames(report, CONSUMPTION);
  const { dependencies } = report;
  const primary = dependencies.primaryConsumer;
  let summary: string | undefined;
  if (primary !== undefined && dependencies.consumerPackages === 1) {
    summary = `${primary.package} is the only consumer${
      names.includes("one-way-satellite")
        ? ", and this package does not depend back on it"
        : ""
    }.`;
  } else if (primary !== undefined) {
    summary = `${primary.package} holds ${percent(primary.referenceShare)} of external references across ${plural(dependencies.consumerPackages, "consumer package")}; each used symbol reaches ${dependencies.averageSymbolDistribution.toFixed(2)} of them on average.`;
  }
  return {
    names,
    ...(summary !== undefined && { summary }),
    facts: [],
    raw: profileRaw(report, CONSUMPTION),
  };
}

function gravity(report: SurfaceReport): SignalGroup {
  const names = profileNames(report, GRAVITY);
  const { target } = report.dependencyGravity;
  if (target.cycle.member) {
    names.push("dependency-cycle");
  }
  if (names.length === 0) {
    return { facts: [], names, raw: [] };
  }
  const summary =
    `${plural(target.direct.fanIn, "package")} depend on this one and it depends on ${target.direct.fanOut}; changes here reach ${percent(target.reach.dependents)} of workspace packages` +
    (target.cycle.member
      ? `, and it sits in a dependency cycle of ${plural(target.cycle.size, "package")}.`
      : ".");
  return { facts: [], names, raw: profileRaw(report, GRAVITY), summary };
}

function surface(report: SurfaceReport): SignalGroup {
  const family = new Set(["surface-heavy"]);
  const names = profileNames(report, family);
  if (names.length === 0) {
    return { facts: [], names, raw: [] };
  }
  const { summary } = report;
  return {
    facts: [],
    names,
    raw: profileRaw(report, family),
    summary: `${plural(summary.packagePublicSymbols, "public symbol")}, ${summary.externallyUsedSymbols} used outside the package (${percent(summary.exportUtilization)}).`,
  };
}

/** Returns undefined when any interpolated metric is missing. */
function when(
  strings: TemplateStringsArray,
  ...values: (string | undefined)[]
): string | undefined {
  if (values.some((value) => value === undefined)) {
    return undefined;
  }
  return String.raw({ raw: strings }, ...values);
}

function metrics(evidence: readonly PressureEvidence[]) {
  const map = new Map(
    evidence.map((entry) => [
      entry.metric,
      metricValue(entry.metric, entry.value),
    ])
  );
  return (metric: string) => map.get(metric);
}

function rawLine(evidence: readonly PressureEvidence[]): string {
  return evidence
    .map((entry) => evidenceLine(entry.metric, entry.value))
    .join(" · ");
}

function pressureFact(signal: StructuralPressureSignal): string {
  const m = metrics(signal.evidence);
  let sentence: string | undefined;
  switch (signal.kind) {
    case "surface-pressure":
      sentence = when`${m("packagePublicSymbols")} public symbols with ${m("externallyUsedSymbols")} used outside, and one consumer holds ${m("primaryConsumerShare")} of references`;
      break;
    case "integration-pressure":
      sentence = when`depends on ${m("outgoingPackages")} packages through ${m("outgoingImportSites")} import sites; dependency reach ${m("dependencyReach")}`;
      break;
    case "centralization-pressure":
      sentence = when`${m("incomingReferences")} references from ${m("incomingPackages")} packages, ${m("destinationConcentration")} landing in ${m("destinationModule")}`;
      break;
    case "internal-structure-pressure":
      sentence = when`module chains ${m("maxModuleDepth")} deep against package depth ${m("packageDepth")}; ${m("topInternalModule")} has fan-in ${m("topInternalModuleFanIn")}; ${m("branchHeavyFunctions")} branch-heavy functions`;
      break;
  }
  return `${signal.kind}: ${sentence ?? rawLine(signal.evidence)}`;
}

function boundaryFact(boundary: BoundaryPressureSignal): string {
  const m = metrics(boundary.evidence);
  const head = when`from ${boundary.from} into ${boundary.to}, ${m("references")} references over ${m("symbols")} symbols`;
  const concentrated = when`, ${m("destinationConcentration")} into ${m("topDestinationModule")}`;
  const broad = when`, across ${m("destinationModules")} destination modules`;
  const body =
    head === undefined
      ? rawLine(boundary.evidence)
      : head +
        (boundary.shape === "broad" ? (broad ?? "") : (concentrated ?? "")) +
        ` (${boundary.shape})`;
  return `boundary-pressure: ${body}`;
}

function pressure(report: SurfaceReport): SignalGroup {
  const { signals, boundaries } = report.structuralPressure;
  const names: string[] = signals.map((signal) => signal.kind);
  if (boundaries.length > 0) {
    names.push("boundary-pressure");
  }
  return {
    facts: [...signals.map(pressureFact), ...boundaries.map(boundaryFact)],
    names,
    raw: [
      ...signals.map((signal) => `${signal.kind}: ${rawLine(signal.evidence)}`),
      ...boundaries.map(
        (boundary) =>
          `boundary-pressure ${boundary.from} into ${boundary.to}: ${rawLine(boundary.evidence)}`
      ),
    ],
  };
}

/** Only what analysis already gated by its own policy; no new thresholds. */
function history(report: SurfaceReport): SignalGroup {
  const names: string[] = [];
  const facts: string[] = [];
  const { hotspots, changeCoupling, evolutionaryPressure } = report;
  const top = hotspots.available ? hotspots.files[0] : undefined;
  if (hotspots.available && top !== undefined) {
    names.push("hotspots");
    facts.push(
      `hotspots: ${plural(hotspots.summary.hotspots, "source file")} of ${hotspots.summary.eligibleSourceFiles} change often and carry complexity; highest ${top.file} (${plural(top.evolution.commits, "commit")})`
    );
  }
  if (
    changeCoupling.available &&
    changeCoupling.summary.filePairsWithoutStaticEdge > 0
  ) {
    names.push("change-coupling");
    facts.push(
      `change-coupling: ${changeCoupling.summary.filePairsWithoutStaticEdge} of ${plural(changeCoupling.summary.filePairs, "strong file pair")} have no static dependency between them`
    );
  }
  if (evolutionaryPressure.available) {
    for (const signal of evolutionaryPressure.reinforced) {
      names.push(signal.kind);
      facts.push(
        `${signal.kind}: history reinforces ${signal.staticSignal} over ${plural(signal.support.commits, "commit")}`
      );
    }
    const byKind = new Map<string, ArchitecturalTension[]>();
    for (const tension of evolutionaryPressure.tensions) {
      byKind.set(tension.kind, [...(byKind.get(tension.kind) ?? []), tension]);
    }
    for (const [kind, tensions] of byKind) {
      const [first] = tensions;
      if (first === undefined) {
        continue;
      }
      names.push(kind);
      facts.push(
        tensions.length === 1
          ? `${kind}: ${first.summary}`
          : `${kind} (${tensions.length}): ${first.summary}`
      );
    }
  }
  return { facts, names, raw: [] };
}
