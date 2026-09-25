# Quirks terminology and API follow-ups

These are pending implementation decisions, not APIs available in the current
release. This maintainer note is excluded from the Blume site.

The public `workspaces.add()` / `workspaces.git()` API and `Workspaces` type are
implemented. The lower-level `WorkspaceSystem` class remains internal to the
workspaces package. Runtime binding, monitor access, tests, and exports use the
new Quirks shape.

## Public labels

`list` labels directly registered steps as workflows.
Distinguish steps, workflows, monitors, and schedules in output
without introducing a `quirk()` object.

## Dry runs and harness detection

Decide whether dry execution should prevent launchd mutations and temporary
worktree directories. Model dry runs still require detected executor references.
Deterministic work now runs without a harness. The help and public `cwd` wording
now distinguish state persistence and execution context from side-effect control.

## Agent specifications and session storage

`AgentSpec` accepts `mcp`, `mesh`, and `tools`, while Quirks does not wire them
into its session runtime. Narrow the public type, reject unsupported settings,
or implement them. Session storage comments now describe disk-backed and
in-memory behavior.

## Scope and completion

LaunchAgent labels need workspace identity to avoid cross-project collisions.
Retained review session IDs need repository identity when one workspace reviews
multiple repositories. The development example `PASS` parser should not imply verified
completion, particularly when a response contains both `PASS` and findings.

## Authored release copy

The release generator rebuilds both changelogs from Git history. Give the authored
`first-release.md` introduction an explicit input to release generation before
expecting it in npm or GitHub release notes. Decide whether the package changelog
should continue carrying the entire repository's history.

## Run stream retention

`step.subscribe()` replays a run's events and chunks from its start, so each
run keeps that history in memory until its scope closes. Dispatched runs are
not disposed when they settle; they live until the engine stops. Decide
whether settled runs should be disposed (or their history trimmed) once hosts
have read what they need, especially for long-lived dashboards streaming agent
output.

## Executors after model-routed harness selection

Harness selection now goes through the model manager (`selectExecutor`), and
`--dry` echoes every allowed harness. `Primitives.executors` still lists the
detected CLI harnesses (or the dry ones) but nothing in Quirks requires it.
Decide whether to remove it or replace it with a harness listing derived from
the model manager.
