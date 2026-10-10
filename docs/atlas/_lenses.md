# Lenses

Maintainer note, excluded from the Blume site. Dated 2026-10-10. The
contract every lens follows, set in 1.9 so that 2.1 builds the layer
against it. It is a shape only: no code implements it yet, and the type
ships with the first lens in 2.1. The ground rules, chief among them that
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
 * manifest that is finally published.
 */
type LensReader = Omit<DatasetReader, "history" | "manifest">;

/** A lens's id: stable, it names the lens's stage and its file in the dataset. */
type LensId = string;

interface Lens<Source, Output, K extends keyof LensSettings = never> {
  id: LensId;
  /** The lenses whose output this one reads; they run first. 2.1 gives the reader a way to read them. */
  consumes?: readonly LensId[];
  /** Bumped when Output's shape or meaning changes; the lens stage's schemaVersion. */
  schemaVersion: number;
  /** The settings the lens reads; a lens that names none sees none. */
  settings: readonly K[];
  /** Picks every dataset field the lens reads, as the codex's readCodexSource does. */
  read(reader: LensReader): Promise<Source>;
  /** Pure: the same source and settings give the same output. */
  derive(source: Source, settings: Pick<LensSettings, K>): Output;
}
```

`read` and `derive` are the codex's split (`web/codex/source.ts`,
`web/codex/resolve.ts`): `Source` lists every field the lens reads, so
`derive` can be tested on plain values, and a change to the dataset shows
which lenses it reaches.

## Rules

- **Inputs.** The reader and the settings the lens names, and nothing
  else: no file system, no Git, no TypeScript program, no configuration
  beyond its settings. A lens never analyzes again.
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
  `consumes`; the stage graph orders them.
- **Versioning.** One `SemanticStage` per lens, in `SEMANTIC_STAGE_VERSIONS`,
  with the lens's `schemaVersion`. Its stage fingerprint covers the code.
  Outputs are recomputed on every scan, so none is reused, until a
  per-setting digest exists (2.6 at the earliest).
- **Failure.** A lens that throws fails the scan, as an analysis does.
- **Where they run.** Dry runs and history snapshots run no lenses.
- **Terminal output** renders a lens's output through a report view
  (`lib/render/views.ts`), separately from the lens (2.7). The lens itself
  returns no display strings.

## In the dataset

Decided in 2.0: lenses run at scan time, and their output is written into
the dataset. Settings never enter the configuration fingerprint, so a
settings-only edit reuses every package's results, and every lens output
is recomputed on every scan. Each lens's output is a file the manifest
names, with the entry `{ file, schemaVersion }`. A digest per setting, so that a reader can tell
which settings an output was derived under, comes only when something
consumes it: 2.6 at the earliest.
