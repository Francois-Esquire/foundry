# Domains

Maintainer note, excluded from the Blume site. Dated 2026-10-09. How a
workspace tells Atlas its own mental model, so that Atlas can tell an
intended placement from an accidental one without hiding either. This is a
foundation: the shape is set now, and it grows only when codemods or the
map show a need. See the ground rules in [`_phases.md`](./_phases.md).

## What Atlas is for

In the maintainer's words, Atlas should show where things are wrong, based
on what we see. The case that defines it: a section of one package is used
by one other library and nowhere else. From that observation there are two
honest conclusions. Either it belongs in the library that uses it, or it
belongs where it is, for reasons of domain that usage alone cannot show.
Atlas measures the first. Only the workspace knows the second.

Domains are how the workspace says the second. Example: a domain concept
lives in a shared library, and one package uses it today because the next
package to use it is being built this week. The workspace says the
library's folder is part of that domain. Atlas keeps measuring and keeps
showing that it has one consumer, and labels the placement as belonging to
the domain instead of as a departure.

A domain never hides an observation and never fails a check on its own.

## What a domain is

A named set of facets, spread across the workspace. A domain is not
confined to one package: billing can be a package, a folder in another, a
few files in a third, and one symbol in a fourth.

- **Facets** are paths, and symbols within a path.
- **Nesting.** A domain may contain domains: finances contains billing and
  payments.
- **Overlap.** A place may belong to more than one domain. A requirement
  that cuts across several areas is a domain too.
- **Weight and reason.** A domain may carry a weight and a reason, for the
  lens to report and later for rules to use. Both optional.
- **No expiry.** A domain is true until someone edits it.

The shape, as a sketch for the configuration work in phase 1:

```ts
domain("finances", {
  domains: [
    domain("billing", {
      facets: ["packages/billing", "packages/core/src/ids.ts#InvoiceId"],
    }),
    domain("payments", { facets: ["apps/checkout/src/payments"] }),
  ],
  reason: "Money moves through one model.",
});
```

## Identity is the file system

- **Packages, folders, files.** The workspace-relative POSIX path. A
  package is the folder that holds its `package.json`.
- **Symbols.** The file's path, `#`, and the symbol's name:
  `packages/core/src/ids.ts#InvoiceId`.
- **Concepts are not facets.** The scan's concepts stay observations.

The scan already uses these ids. Symbol ids are `path#name` relative to the
workspace root, so a symbol facet matches `SurfaceSymbol.id` directly, and
dataset module ids are workspace-relative paths. Only the internals layer
uses package-relative ids; the lens joins them as
`${package.root}/${module.id}`, as `web/internals.ts` already does. No
analysis changes. The dataset's package id, though, is the `package.json`
name, while facets address packages by path; the lens maps one to the
other through the manifest's `path`.

One known gap: the id drops the declaration kind, so an interface and a
const of one name share an id. A facet without a kind matches every symbol
with that id. See [`_phases.md`](./_phases.md#changes-to-existing-code).

## Built as a lens

Domains are read by a lens, not by the analyses. The lens takes the
dataset and the declared domains, and for each place compares where it
lives with where it is used:

| Label | Meaning |
| --- | --- |
| Fits | Used where it lives. |
| Shares a domain | Used from another package, by places in a domain it belongs to. |
| Departs | Used away from where it lives, by places that share none of its domains. |

Everything it reads is already in the dataset:

- `packages/<name>.json`: each symbol's `consumerPackages`, `consumers`,
  `primaryConsumerShare`, and `consumerModuleUsage`; the package's
  `primaryConsumer` and `single-consumer` signal; opportunities such as
  `fold-package`, which already gates on exactly one consumer package.
- `modules/` edge shards: cross-package module edges, for files and
  folders.
- `internals/<name>.json`: scopes with parent chains and symbol locality,
  for nesting and placement inside a package.
- `workspace.json`: package paths and anchors.

The motivating case is measured today and not reported: per-symbol
consumer packages are computed for every package, and the only reader is a
top-five list in the old text report. At package level, `fold-package`
covers it. At file and folder level it is a sum over module edges.

The existing analyses decline to call something misplaced on usage alone,
on purpose (concept miscentering's `usage-only` outcome). The domain lens
does not change that; it adds the side only the workspace knows.

Where domains need to reach the gates, `AnalysisConfig.anchors` is the
existing path: a package anchored there cannot be folded away, and
readiness reports an `anchor-violation`. Anchors are built in today and
cannot be supplied by a workspace; opening that is a phase 3 change, listed
in [`_phases.md`](./_phases.md#changes-to-existing-code).

## Later, when needed

How weights combine, how nested and overlapping domains roll up into one
label, and whether rules are written in terms of domains. Each waits until
a codemod or the map needs the answer.
