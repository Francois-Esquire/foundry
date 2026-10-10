# Domains

Maintainer note, excluded from the Blume site. Dated 2026-10-09, updated
2026-10-10. How a
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

## How a workspace declares them

Set in 1.9. A configuration file in `.foundry/atlas/` default-exports them
under `domains`, as plain objects
(`DomainDeclaration` in `apps/atlas/src/lib/domain-declaration.ts`):

```ts
// .foundry/atlas/domains.ts
export default {
  domains: [
    {
      name: "finances",
      reason: "Money moves through one model.",
      domains: [
        {
          name: "billing",
          facets: ["packages/billing", "packages/core/src/ids.ts#InvoiceId"],
          weight: 0.8,
        },
        { name: "payments", facets: ["apps/checkout/src/payments"] },
      ],
    },
  ],
};
```

A domain is `{ name, facets?, domains?, reason?, weight? }`. The rules, each
checked when the configuration loads, with the file and the setting named
in the error:

- **Name.** Lowercase letters, digits, and hyphens, starting with a letter.
  The name is the domain's id, so it is unique across the whole tree, nested
  domains included: two different billing domains need two names.
- **Facets.** A workspace-relative POSIX path, optionally followed by `#`
  and one symbol's name. `/` separates segments; there is no leading `/` or
  drive letter, no leading or trailing whitespace, no empty, `.`, or `..`
  segment, no trailing `/`, and a file before any `#`. `*`,
  `?`, and a leading `!` are reserved for patterns, so that adding them
  later changes no facet's meaning; `[ ] ( ) { }` are allowed, since route
  folders such as `[id]` and `(shop)` are real paths. Facets are
  case-sensitive and written as the lens will match them, never normalized.
- **A facet's path need not exist.** The motivating case declares a place
  before its second consumer is written. The loader never looks; the domain
  lens reports every facet that matches no place.
- **Something to name.** A domain has at least one facet or one nested
  domain. A facet listed twice in one domain is an error; the same facet in
  several domains is overlap, and allowed.
- **Nesting is membership.** A place in a nested domain is in its parent
  too: a billing facet is in finances. Nesting stops at 64 levels. A
  configuration file is code, so a tree that holds itself, or lists one
  object twice, is refused by its path before it is walked.
- **Weight** is a number from 0 to 1: the workspace's own emphasis, reported
  as written. How weights combine is not decided. **Reason** is non-empty text with
  no leading or trailing whitespace. Both are optional, and an absent weight has no
  default.
- **One file.** `domains` is a key like any other, declared in one
  configuration file. That file may import `_`-prefixed helpers that hold
  parts of the tree.
- **Not an analysis input.** No analysis reads domains, and the
  configuration fingerprint leaves them out, so a scan with new domains
  reuses every package's results. `foundry.config.json#semantics`, the 0.x
  fallback, does not accept them.

### What a symbol facet can name

`path#name` matches `SurfaceSymbol.id` as the scan forms it
(`symbols.ts:133`), which sets its limits:

- The path is the file that declares the symbol, not one that re-exports
  it.
- The name is the declared name, as the compiler's `getName()` returns it,
  not an export alias. A default export is named by its declaration
  (`export default function total` is `#total`), never `#default`; an
  anonymous one cannot be named.
- Top-level declarations only: no members, no dotted namespace paths, and
  no quoted ambient module names.
- The id carries no kind, so a facet matches every symbol of that name in
  the file, an interface and a const alike. Logged in
  [`_phases.md`](./_phases.md#changes-to-existing-code).

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
other through the workspace report,
`workspaceReport().packages.packages[].path`. That `path` is optional: a
package known only as an edge or concept endpoint has none, and no facet
can name it.

One known gap: the id drops the declaration kind, so an interface and a
const of one name share an id. A facet without a kind matches every symbol
with that id. See [`_phases.md`](./_phases.md#changes-to-existing-code).

## Built as a lens

Domains are read by a lens, not by the analyses; the contract every lens
follows is in [`_lenses.md`](./_lenses.md). The domain lens takes the
dataset and the declared domains as a setting, and for each place compares
where it lives with where it is used:

| Label | Meaning |
| --- | --- |
| Fits | Used where it lives. |
| Spread | Used from more than one package, possibly its own, none of which holds the dominant share. |
| Shares a domain | Used from another package, by places in a domain it belongs to. |
| Departs | Used away from where it lives, by places that share none of its domains. |

Fits, Spread, and Departs come first, from the `placement` lens (2.3),
before any domain exists: it labels every exported symbol, file, folder,
and package from its consumer modules, with `dominantShare` 0.6. The two
departs are different labels: placement's says one other package holds
the dominant share of a place's consumer modules, the domain lens's that
its consumers share none of its domains. The domain lens keeps them apart
by name, in its output and in prose, for example as a placement departure
against a domain departure, so neither reads as the other. The domain lens
consumes it and relabels a spread or departing place whose consumers share
one of its domains. Placement stays compact, listing only the places a
consumer in another package uses, each with those consumer modules by
package, so the domain lens reads what else it needs itself to report the
facets that match no place: the module index for files and folders, and
each package report's symbol ids for symbols. A facet naming a symbol its
module does not export still matches a place; placement only leaves it
unlabelled.

Everything it reads is already in the dataset:

- `packages/<name>.json`: each symbol's `consumerPackages`, `consumers`,
  `primaryConsumerShare`, and `consumerModuleUsage`; the package's
  `primaryConsumer` and `single-consumer` signal; opportunities such as
  `fold-package`, which already gates on exactly one consumer package.
- `modules/index.json`: each file's package and kind, which tells a
  consumer module's package and leaves out tests.
- `internals/<name>.json`: the topology's consumed surface, each symbol's
  consumers inside its package, and its directories, for placement at home;
  scopes with parent chains, for nesting.
- `workspace.json`: package paths and anchors.

The motivating case is measured today and not reported: per-symbol
consumer packages are computed for every package, and the only reader is a
top-five list in the old text report. At package level, `fold-package`
covers it. At file and folder level it is the union of the consumer modules
of the symbols declared there, not a sum over module edges: a module edge
points at the module imported, often a barrel (on Foundry,
`packages/artifacts/src/index.ts` receives 40 cross-package edges), while a
symbol's consumer modules are attributed to the file that declares it.

The existing analyses decline to call something misplaced on usage alone,
on purpose (concept miscentering's `usage-only` outcome). The domain lens
does not change that; it adds the side only the workspace knows.

Where domains need to reach the gates, `AnalysisConfig.anchors` is the
existing path: a package anchored there cannot be folded away, and
readiness reports an `anchor-violation`. Anchors are built in today and
cannot be supplied by a workspace; opening that is a phase 3 change, listed
in [`_phases.md`](./_phases.md#changes-to-existing-code).

## Later, when needed

Each waits until a codemod or the map needs the answer:

- How nested domains roll up into one label for a place.
- How overlapping domains combine into one label for a place.
- How weights combine, across nesting and across overlap.
- Patterns in facets, with the reserved `*`, `?`, and leading `!`.
- Domains declared across several configuration files, which would relax
  the one-file rule without breaking a configuration that keeps it.
- A `domain()` helper, and `satisfies AtlasConfig` typing, once 1.10
  exports `AtlasConfig` from `@foundry/atlas`.
- Whether rules are written in terms of domains.
