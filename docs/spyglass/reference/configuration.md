---
title: Configuration
description: The configuration directory, .foundry/spyglass/, its settings, domains, and rules, and what else Spyglass reads from a workspace.
---

Spyglass takes its runtime options from the command line. What a workspace
declares to Spyglass, its configuration, lives in its configuration directory,
`.foundry/spyglass/` at the workspace root. A workspace without one scans with
the defaults.

## The configuration directory

Each configuration file in `.foundry/spyglass/` default-exports part of the
configuration as a plain object:

```ts
// .foundry/spyglass/index.ts
export default {
  exclude: ["packages/fixtures"],
  history: { checkpoints: 12, every: 100, range: "1y", strategy: "monthly" },
};
```

- Files are TypeScript or JavaScript: `.ts`, `.tsx`, `.mts`, `.cts`, `.js`,
  `.jsx`, `.mjs`, or `.cjs`. Declaration files (`.d.ts`) are skipped.
- Files and directories whose names start with `_` or `.` are skipped, and
  so is `node_modules`. A configuration file can import a `_`-prefixed
  helper file; every other file must have a default export. Symbolic links
  are not followed.
- Each key, a top-level setting, is declared in one file only. Splitting the
  configuration across files is fine as long as no two files declare the
  same key.
- A configuration directory reached through a symbolic link, at `.foundry`
  or at `.foundry/spyglass`, is refused.
- Nothing has to be installed for the files to run. A type-only import is
  removed before the file runs, so `import type { SpyglassConfig } from
  "@foundry/spyglass"` and `satisfies SpyglassConfig` check a file in an editor
  where Spyglass is installed, and cost nothing where it is not; see the
  [library](/spyglass/reference/library#configuration-files).

## Settings

| Setting | Type | Default | Effect |
| --- | --- | --- | --- |
| `domains` | list of domains | `[]` | The workspace's own model, which the `domains` lens reads at every scan; no analysis reads it. See [Domains](#domains). |
| `exclude` | `string[]` | `[]` | Workspace-relative unit directories to skip, matched exactly, such as `packages/fixtures`. A leading `./` and a trailing slash are dropped; an absolute path, `.`, or a path with a `..` segment is an error. The manifest lists each excluded unit with the reason `excluded`, and an exclusion that matched no unit under `discovery.excludeUnmatched`. Excluding a unit that would otherwise be analyzed leaves the workspace's coverage `partial`. |
| `history.checkpoints` | whole number, at least 1 | `12` | Upper bound on checkpoints per `--history` scan. `HEAD` always counts. |
| `history.every` | whole number, at least 1 | `100` | Commit stride for the `every-n-commits` strategy. |
| `history.range` | string | `"1y"` | How far back from `HEAD`: `<n>y` for years, `<n>m` for months, `<n>d` for days, or `all`. |
| `history.strategy` | string | `"monthly"` | `monthly`, `evenly-spaced`, or `every-n-commits`. |
| `rules` | list of rules | `[]` | What the workspace permits or requires of its own structure; no analysis reads it. See [Rules](#rules). |

Unknown keys are errors. Which directories are packages is not a setting:
the workspace declaration decides it (see
[What else Spyglass reads](#what-else-spyglass-reads)). Analysis thresholds are not
configuration either; they are built in.

## Domains

A domain is a named part of the workspace's own model: the places it names
as its own, its facets, which may span packages, and the domains nested
inside it. Spyglass uses domains to tell an intended placement from an
accidental one, without hiding either: the `domains` lens saves, in
`lenses/domains.json`, the places each domain's facets name, the facets
that name none, and a domain label for every place the `placement` lens
lists inside a domain. See [the dataset](/spyglass/reference/output).

```ts
// .foundry/spyglass/domains.ts
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

| Field | Type | Effect |
| --- | --- | --- |
| `name` | string | The domain's id: lowercase letters, digits, and hyphens, starting with a letter. Unique across every domain, nested ones included. |
| `facets` | `string[]` | The places the domain names: a package, folder, or file by its workspace-relative path, or a symbol as `path#name`. |
| `domains` | list of domains | Domains nested inside this one. A place in a nested domain is in its parent too. |
| `reason` | string | Why the domain exists, as written. Non-empty, with no leading or trailing whitespace. |
| `weight` | number from 0 to 1 | The workspace's own emphasis, reported as written. |

A domain needs at least one facet or one nested domain. A facet:

- is relative to the workspace root and uses `/`, with no empty, `.`, or
  `..` segment, no trailing `/`, and no leading or trailing whitespace. It
  is matched exactly as written, case included;
- may name one top-level symbol after `#`, by the name its file declares
  it with: `packages/core/src/ids.ts#InvoiceId`;
- may not use `*`, `?`, or a leading `!`, which are kept for patterns;
- need not exist yet. A facet that matches nothing is kept, and the
  `domains` lens lists it as unmatched.

The same facet may appear in several domains; listed twice in one domain,
it is an error. Domains nest at most 64 deep, and a domain may not contain
itself. `domains` is declared in one configuration file, like every
key; that file may import `_`-prefixed helpers. `foundry.config.json` does
not accept domains.

A place is in a domain when one of the domain's facets covers it: a path
facet covers everything at or below its path, a symbol facet only its
symbol. A place in a nested domain is in its parents too.

Domains are not an analysis input: a scan with new domains reuses every
package's results, and only the lens outputs are written again.

## Rules

A rule says what the workspace wants to be true of its own structure: that
an operator may be applied to the places under a subject, or that its
outcome must hold there.

```ts
// .foundry/spyglass/rules.ts
export default {
  rules: [
    { operator: "internalize", subject: "packages/core", effect: "require" },
    {
      operator: "internalize",
      subject: "packages/lib/src/ids.ts#InvoiceId",
      effect: "permit",
    },
  ],
};
```

| Field | Type | Effect |
| --- | --- | --- |
| `operator` | string | The kind of change the rule is about. `internalize`, a package-public symbol leaving its package's public surface, is the only one so far; others are added as Spyglass learns to apply them. |
| `subject` | string | The place the rule names, written as a facet: a package, folder, or file by its workspace-relative path, or a symbol as `path#name`. The rule covers the subject and everything below it. |
| `effect` | string | `permit`: a plan to apply the operator to a place under the subject may be authorized. `require`: under the subject, the operator's outcome must hold; for `internalize`, no package-public symbol is unused outside its package. A `require` permits too. |

A subject follows the facet rules of [Domains](#domains): relative to the
workspace root, `/` as the separator, no empty, `.`, or `..` segment, no
trailing `/`, no `*`, `?`, or leading `!`, and at most one symbol after
`#`. It covers by whole segments, so `packages/co` does not cover
`packages/core`, and it need not exist yet.

A rule is named by its index, as errors name it: `rules[0]`. Reordering the
list renames every rule. One operator and subject take one rule: the same
rule twice is an error, and so is a `permit` beside a `require` of the same
subject, since the `require` already permits. `rules` is declared in one
configuration file, like every key. `foundry.config.json` does not accept
rules.

Rules are not an analysis input: a scan with new rules reuses every
package's results, and writes the `rules` lens again. That lens,
`lenses/rules.json`, holds the rules as declared and every place that
breaks a `require`; [`spyglass check`](/spyglass/reference/cli#check) prints it
and exits `3` when a rule is broken.

## Errors

The configuration is checked before anything is analyzed. Each message
names the file and the setting, and lists every problem in that file:

```text
Configuration .foundry/spyglass/index.ts: history.strategy must be monthly, evenly-spaced, or every-n-commits; got "weekly".
Configuration .foundry/spyglass/index.ts: unknown key lenses.
Configuration .foundry/spyglass/rules.ts: rules[0].operator must be "internalize", the one operator rules can name so far; got "move".
Configuration .foundry/spyglass/domains.ts: domains[0].facets[1] must be relative to the workspace root; got "/packages/billing".
Configuration .foundry/spyglass/index.ts: the default export must be an object.
Configuration .foundry/spyglass/index.ts: the file has no default export. Export the configuration as the default, or start a helper file's name with _.
Configuration .foundry/spyglass/index.ts: loading the file threw: <the error>
Configuration .foundry/spyglass/index.ts: the file ended the process while it was loading: <its last error line>
Configuration: exclude is declared in .foundry/spyglass/a.ts and .foundry/spyglass/b.ts. Declare it in one.
Configuration: .foundry/spyglass is a symbolic link; Spyglass does not follow links.
```

A configuration that takes longer than 30 seconds to load fails the scan
with `Configuration: .foundry/spyglass/ did not finish loading within 30
seconds.` The process that loads it is killed; processes a configuration
file starts itself are not.

## `foundry.config.json`, during 0.x

When there is no `.foundry/spyglass/` directory, Spyglass reads the `semantics`
key of `foundry.config.json` at the root instead, with the same settings and
the same checks. Other keys in the file are left alone.

```json
{
  "semantics": {
    "exclude": ["packages/fixtures"],
    "history": { "range": "6m" }
  }
}
```

Two settings it used to read are rejected now:

- `semantics.output`: the dataset is saved under the state directory.
- `semantics.roots`: Spyglass finds packages from the workspace declaration.

If `.foundry/spyglass/` exists and `foundry.config.json` also has a `semantics`
key, the scan fails with `foundry.config.json: semantics is ignored because
.foundry/spyglass/ exists. Move it there, or remove it.` The file itself may stay,
since other tools share it.

## Running the configuration

Configuration files are code, so loading them runs the workspace's code.
Scanning a workspace runs its `.foundry/spyglass/` files with your privileges,
as ESLint and Vite configuration files do. Take care when you scan an
untrusted repository, for example in CI on pull requests from forks.

When the configuration runs:

- Only `spyglass scan`, the default `spyglass` command, and the library's `scan`,
  `scan.workspace`, and `scan.package` load it, once per call, from the
  working tree.
- `spyglass serve`, the library's `serve`, and reading a saved dataset never
  run it.
- A `--history` scan applies the working tree's configuration to every
  checkpoint. A checkpoint's own `.foundry/spyglass/` is never run.
- The files run in a separate Bun process on every load, so an edited file,
  or an edited helper it imports, is seen by the next scan in the same
  process.

A changed `exclude` invalidates the cached package reports on the next
scan; the package-local analyses are reused. Domains, rules, and history
settings invalidate none. An edit that changes no setting, such as a comment,
invalidates nothing.

## What else Spyglass reads

- The workspace declaration: the `packages` list in `pnpm-workspace.yaml`
  when that file has one, or else `workspaces` in the root `package.json`,
  as an array or as `{ "packages": [] }`. Its package patterns decide the
  units and the TypeScript program. A workspace that declares no packages
  is not scanned. How Spyglass reads a pattern:
  - A pattern without `*` (`docs`) matches that directory.
  - A pattern is expanded at its first `*`, one level: Spyglass lists the child
    directories of the path before it. `apps/*` matches every child of
    `apps`, and so do `apps/**` and `apps/*/lib`; a `*` inside a name, as in
    `packages/ui-*`, matches nothing.
  - A leading `./` and a trailing slash are dropped.
  - `!` negations are ignored; put negated directories under `exclude`
    instead.
  - A pattern that resolves to the workspace root (`.`) or escapes it
    (`../*`) is ignored, and is not reported as unmatched.
- The root `package.json`'s `name`, as the workspace name.
- Each unit's `package.json`: `name`, `exports`, `main`, `module`, and
  `private`, to decide what the package exposes.
- Each unit's `tsconfig.json`: `paths` that point inside the package, and
  `references`.
- Every `.gitignore` between the root and a file. Global excludes are not
  read.
- Git, when the directory is a repository: the full log with renames, and
  the tracked file list.

No environment variables are read.
