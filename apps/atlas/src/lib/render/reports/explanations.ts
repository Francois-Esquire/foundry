/**
 * Plain-language definitions for the concepts the default report shows.
 * Presentation only: each entry restates the analysis policy in README and
 * `config.ts`; changing a threshold there must change the sentence here.
 */
export const SURFACE_RATIOS = [
  "Declared package surface: the share of all symbols reachable through the package entrypoints. High means most of the package is public by declaration.",
  "External surface: the share of all symbols another package actually uses. This approximates how much responsibility crosses the boundary.",
  "Export utilization: of the package-public symbols, how many are used outside. Low means the declared surface is wider than its consumers need.",
];

export const OPPORTUNITIES = [
  "An opportunity is a structural pattern that passed every hard gate for its operation. Evidence confidence measures how strongly the observed facts match that pattern; it is not a probability that the change is a good idea, and nothing here acts on it.",
  "Eligibility blocks list the gates a package-level operation failed, so an absent opportunity stays explainable.",
];

export const ANCHOR =
  "An anchor is declared intent: this boundary stays as it is. Analysis still runs and signals still fire; only folding this package away is blocked.";

const SIGNALS: Record<string, string> = {
  "boundary-pressure":
    "one package-to-package edge carrying substantial traffic: broad (many symbols) or concentrated (landing in one module).",
  "broadly-consumed":
    "three or more consumers and no single one holds 80% of references.",
  "centralization-pressure":
    "high fan-in, heavy incoming references, and one module receiving most of them.",
  "change-coupling":
    "files that keep changing in the same commits with no import between them; a relationship the static graph cannot see.",
  "concentrated-consumption":
    "one consumer holds most of the external references.",
  "dependency-cycle":
    "this package and others depend on each other in a loop; none can change alone.",
  "distributed-consumption": "references spread across several consumers.",
  "foundation-like":
    "widely depended on, depends on little; changes here reach far downstream.",
  "high-fan-in": "many packages depend on this one.",
  "high-fan-out": "this package depends on many others.",
  hotspots:
    "source files that change often and carry executable complexity; where edits are most likely to be risky.",
  "integration-like":
    "depends on many, depended on by few; it assembles other packages.",
  "integration-pressure":
    "high fan-out, wide dependency reach, and many outgoing import sites at once.",
  "internal-structure-pressure":
    "deep internal module chains, a dominant internal module, and branch-heavy functions at once.",
  "leaf-like": "at most one dependent and one or two dependencies.",
  "narrowly-consumed": "the primary consumer holds 80% or more of references.",
  "one-way-satellite":
    "a single consumer, and this package does not depend back on it.",
  "reinforced-centralization-pressure":
    "development history shows the same centralization pressure the static shape does.",
  "reinforced-integration-pressure":
    "development history shows the same integration pressure the static shape does.",
  "reinforced-internal-structure-pressure":
    "development history shows the same internal-structure pressure the static shape does.",
  "reinforced-surface-pressure":
    "development history shows the same surface pressure the static shape does.",
  "shared-hub": "many consumers each using a broad slice of the surface.",
  "shared-hub-like":
    "three or more consumers, each symbol used by about 1.5 packages on average.",
  "single-consumer": "exactly one package consumes this one.",
  "static-leaf-temporal-coupling":
    "the static shape is a leaf, yet history changes it together with other packages.",
  "static-pressure-low-evolution":
    "the static shape shows pressure, yet history rarely touches it.",
  "surface-heavy":
    "twenty or more public symbols with a quarter or less actually used.",
  "surface-pressure":
    "large public surface, low utilization, and one dominant consumer at once.",
  "temporal-coupling-without-static-path":
    "files change together with no static path connecting them.",
};

/** Definition lines for the signal names present, in the order given. */
export function signalDefinitions(names: readonly string[]): string[] {
  return [...new Set(names)].flatMap((name) => {
    const definition = SIGNALS[name];
    return definition === undefined ? [] : [`${name}: ${definition}`];
  });
}

/**
 * Why a plan is unsupported or blocked, restated from `plan.ts` blocker
 * details. The verdict line states the fact; these say what lifts it.
 */
const BLOCKERS: Record<string, { fact: string; lift?: string }> = {
  "internal-entrypoint-import": {
    fact: "imported from the entrypoint by other modules inside the package",
  },
  "namespace-import": {
    fact: "a module inside the package imports the entrypoint as a namespace, so internal use cannot be ruled out",
  },
  "no-public-route": {
    fact: "not exposed by any declared entrypoint, so possibly package-internal already",
  },
  publishable: {
    fact: 'the package is marked "private": false, so consumers outside this repository are invisible',
  },
  "star-export": {
    fact: "exposed only through an `export *` statement",
    lift: "Selective internalization would mean rewriting that star export as named exports.",
  },
  "unrecognized-route": {
    fact: "exposed through an export form the planner does not recognize",
  },
  "unresolved-entrypoint": {
    fact: "a declared entrypoint could not be resolved to an analyzed source file",
  },
  "wildcard-exports": {
    fact: "the package.json exports map declares a wildcard subpath, so the public routes cannot be enumerated",
    lift: "Naming the subpaths explicitly lifts this for every symbol at once.",
  },
};

/** The fact clause alone, for the verdict line. */
export function blockerPhrase(reason: string): string | undefined {
  return BLOCKERS[reason]?.fact;
}

export function blockerDefinitions(reasons: readonly string[]): string[] {
  return [...new Set(reasons)].flatMap((reason) => {
    const blocker = BLOCKERS[reason];
    if (blocker === undefined) {
      return [];
    }
    return [
      `${reason}: ${blocker.fact}.${blocker.lift === undefined ? "" : ` ${blocker.lift}`}`,
    ];
  });
}
