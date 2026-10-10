# Marbles roadmap

Maintainer note, excluded from the Blume site. The agreed pieces of work,
in order. Items 1 to 3 have landed; 4 stays open alongside 5; 6 comes last.

1. **Streaming runs and the agent work step.** Landed 2026-09-25 (`5e988a8`):
   a run stream in `@foundry/workflows` with replay and path-scoped chunks,
   and prebuilt agent steps that choose their harness through the models
   package. Sessions stay in memory: the built-in harness keeps messages;
   Codex and Claude Code keep only a session id. Still open: no provider
   backs the built-in `@foundry/agents` harness, so the default is the first
   available CLI harness (`_rebuild-gaps.md`, "Open after phase 2").
2. **Rebuild the library against `_api-alt.md`.** Landed in phases, recorded
   in [`_rebuild-gaps.md`](./_rebuild-gaps.md): the builder API and the nine
   top-level words (2026-09-25), the engine split into `src/lib` and
   `src/authoring` (2026-10-04), and the engine over the packages' own
   instances (2026-10-05). Its open items stay in the API doc's "Open"
   section and the gap map.
3. **Companion skill.** Landed 2026-09-25 as `skills/marbles-config`: a
   procedure, an API reference, and the hand-off patterns the API doc
   promises. Its eval loop (baselines, description tuning) is a follow-up.
4. **Docs and use cases.** The Software Factory landed 2026-09-28 and moved
   to `guides/software-factory.mdx` when Guides became the home for
   real-world walkthroughs. More guides for real-world setups are next. The
   creative explorations (Voicekeeper, Unfinished Things, Pen Pal,
   Tastekeeper) are parked in `_creative/` until a creativity track returns.
5. **Use-case findings.** Guides, recipes, and real use find where the API
   runs out; [`_findings.md`](./_findings.md) records each with a proposal,
   and [`_next-api.md`](./_next-api.md) is the technical design for all of
   them. Document each change on the public pages once it lands. In order:
   1. **The agent surface.** Pass-through for agent turns, starting with
      structured output (finding 7.1), and definitions you can use, starting
      with `agent()` returning an agent (finding 8). Both reshape the same
      surface, so they are designed together. Structured output, agent
      settings, and the `agent`, `step`, and `workflow` instances landed
      2026-10-10; the `workspace`, `sandbox`, and `artifact` instances
      (A.5 to A.7) are next.
   2. **Two bugs from the audit.** Worktree defaults apply only inside
      `withWorktree` (7.3), and a scoped artifact `create` is not counted for
      replay (7.4).
   3. **Quick fixes.** A one-line usage error for invalid input (finding 3),
      and `hasBranch` with a clear `withWorktree` error (finding 4).
   4. **Monitors and launchd.** Request options for HTTP monitors (finding
      1) and the environment for launchd ticks (finding 2), which Design
      Sync needs to become a monitor.
   5. **Pass-through for the other keys.** Sandboxes, workspaces,
      artifacts, steps, and skills (7.2 to 7.6), with finding 8's handles
      for `workspace`, `sandbox`, and `artifact`.
   6. **New API that needs design.** Command steps (finding 6) and memory
      between runs (finding 5).
6. **Branding, last.** Bring the brand into the docs on top of item 4. Done
   together with the maintainer, not ahead of time.
