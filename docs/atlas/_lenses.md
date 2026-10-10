# Lenses

Maintainer note, excluded from the Blume site. Dated 2026-10-10. The
contract every lens follows, set in 1.9 and built in 2.1. The types live in
`apps/atlas/src/lib/lenses/lens-types.ts`, the registry and the lens phase
in `lib/lenses/run.ts`, and the first lens, `package-sizes`, in
`lib/lenses/package-sizes.ts`. The ground rules, chief among them that
new views are lenses, are in [`_phases.md`](./_phases.md#ground-rules); the
first lens to read the workspace's domains is in [`_domains.md`](./_domains.md).

## What a lens is

A read-only function over the dataset, plus the settings it names, that
produces a view of places: labels, groupings, and measures. It lives in
`lib` beside the analyses, never inside one, and changes none of them.

## The contract

```ts
/** What a lens may read beyond the dataset: the workspace's own settings. */
interface LensSettings {
  domains: readonly DomainDeclaration[];
}

/**
 * The dataset as a lens reads it: the 1.5 reader without `history()`, which
 * is written after the dataset is published, and without `manifest()`, whose
 * generation fields differ between the draft a lens runs against and the
 * manifest that is finally published. `packages()` stands in for the
 * manifest's package list, by its deterministic fields; `lens(id)` reads a
 * lens that ran earlier in the phase.
 */
type LensReader = Omit<DatasetReader, "history" | "manifest"> & {
  packages(): readonly { id: string; internals: boolean; status: "complete" | "failed" }[];
};

/** Every lens's output by id; a lens's id is a key of this map. */
interface LensOutputs {
  "file-roles": FileRoles;
  "package-sizes": PackageSizes;
  "responsibility-groups": ResponsibilityGroups;
}
type LensId = keyof LensOutputs;

interface Lens<I extends LensId, Source, K extends keyof LensSettings = never> {
  id: I;
  /** The lenses whose output this one reads, through `reader.lens(id)`; they run first, and it may read no others. */
  consumes?: readonly LensId[];
  /** Bumped when the output's shape or meaning changes; the lens stage's schemaVersion. */
  schemaVersion: number;
  /** The settings the lens reads; a lens that names none sees none. */
  settings: readonly K[];
  /** Picks every dataset field the lens reads, as the codex's readCodexSource does. */
  read(reader: LensReader): Promise<Source>;
  /** Pure: the same source and settings give the same output. */
  derive(source: Source, settings: Pick<LensSettings, K>): LensOutputs[I];
}
```

A new lens adds its key to `LensOutputs`, its schema version to
`LENS_SCHEMA_VERSIONS`, its stage to `SEMANTIC_STAGE_VERSIONS` and the
stage dependencies, its view to `LENS_VIEWS`, and itself to `LENSES`. The
maps are keyed by `LensId`, so a missing entry in one of them does not
compile; `LENSES` is an array, and the registry test checks that it holds
every lens once, in `consumes` order.

`read` and `derive` are the codex's split (`web/codex/source.ts`,
`web/codex/resolve.ts`): `Source` lists every field the lens reads, so
`derive` can be tested on plain values, and a change to the dataset shows
which lenses it reaches.

## Rules

- **Inputs.** The reader and the settings the lens names, and nothing
  else: no file system, no Git, no TypeScript program, no configuration
  beyond its settings. A lens never analyzes again. A lens that imports
  `ANALYSIS_CONFIG` reads the built-in analysis policy, not the workspace's
  Configuration, which reaches a lens only through its settings.
- **Output.** JSON data. Names and ids are data, never prose. A place is
  addressed in facet syntax, a workspace-relative path or `path#name`, and
  a package is a place too, so a lens that labels places addresses a
  package by its path; the domain lens does. A lens about packages as
  packages, such as their dependency graph, may use the manifest id
  instead, and says which. Labels are literal unions, such as
  `"fits" | "shares-domain" | "departs"`. Measures are numbers, with the
  counts they come from. Output is sorted, so the same input gives the same
  bytes.
- **Inference is allowed.** Unlike a projection, which copies and never
  infers, a lens may derive, rank, and label. A label adds to an
  observation and never hides one.
- **Lenses may build on lenses.** A lens names the lenses it reads in
  `consumes`; the stage graph orders them. A lens that reads a lens it
  does not consume, or one that has not run yet, fails the scan.
- **Versioning.** One `SemanticStage` per lens, `` `lens:${LensId}` `` in
  `SEMANTIC_STAGE_VERSIONS`, with the lens's `schemaVersion`. Its stage
  fingerprint covers the code. Outputs are recomputed on every scan, with
  no computation skipped, until a per-setting digest exists (2.6 at the
  earliest); an output whose bytes are unchanged keeps its file, as every
  dataset file does. The reader checks each lens's schema version on its
  own, so a lens bump needs no dataset schema bump.
- **Internals.** A lens that needs a package's internals reads them
  through `readPackageInternals(reader)` (`lib/lenses/package-internals.ts`),
  since `scan.workspace` saves none: it returns the packages with
  internals, each with its root, and `missing`, the complete packages
  without them, which the lens lists in its output instead of failing; a
  failed package is in neither. Module ids are root-relative, joined by
  `rootRelative(root, module)` in the same file (a root of `.` adds no
  prefix), which `web/internals.ts` uses too, so a lens and the map name a
  module one way.
- **Shared reads.** Within one scan, the lens phase parses each dataset file
  once and hands the same value to every lens that reads it, so a lens
  never changes what it reads.
- **Failure.** A lens that throws fails the scan, as an analysis does.
- **Where they run.** Dry runs and history snapshots run no lenses.
- **Terminal output** renders a lens's output through a report view
  (`lib/render/views.ts`), separately from the lens (2.7). The lens itself
  returns no display strings.

## In the dataset

Decided in 2.0: lenses run at scan time, and their output is written into
the dataset. The `lenses` phase runs after `write`, internals included, and
before the manifest is written: the lenses read the unpublished tree
through the reader, with the manifest answered by the draft that the
published manifest is built from by the same call. The settings lenses
read (`LensSettings`) never enter the configuration fingerprint, so an edit
to them alone reuses every package's results, and every lens output is
recomputed on every scan. Each lens's output is a file the manifest
names, with the entry `{ file, schemaVersion }`. A digest per setting, so that a reader can tell
which settings an output was derived under, comes only when something
consumes it: 2.6 at the earliest.
