# Marbles roadmap

Maintainer note, excluded from the Blume site. The agreed pieces of work,
in order. Items 1 to 3 and 5 have landed; 4 stays open; 6 comes last.

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
   them. All six parts below landed on 2026-10-10; what they left open is
   under finding 7, and findings 9 and 10 came from that work. In order:
   1. **The agent surface.** Pass-through for agent turns, starting with
      structured output (finding 7.1), and definitions you can use, starting
      with `agent()` returning an agent (finding 8). Both reshape the same
      surface, so they are designed together. Both landed 2026-10-10:
      structured output and agent settings, and an instance for every
      definition (`artifact.latest()` waits for finding 5).
   2. **Two bugs from the audit.** Landed 2026-10-10: worktree defaults on
      every worktree call (7.3), and a scoped artifact `create` counted for
      replay (7.4).
   3. **Quick fixes.** Landed 2026-10-10: `hasBranch` with a clear worktree
      error (finding 4), and one-line errors for invalid input and a `roll`
      that reaches an ask (finding 3).
   4. **Monitors and launchd.** Landed 2026-10-10: request options for HTTP
      monitors (finding 1) and the environment for launchd ticks (finding
      2). Design Sync shows the monitor as a variation until the hash
      question in `_next-api.md` D.1 is settled.
   5. **Pass-through for the other keys.** Landed 2026-10-10: sandboxes,
      workspaces, artifacts, steps, and skills (7.2 to 7.6). What each left
      open is under its section of finding 7.
   6. **New API that needs design.** Landed 2026-10-10: memory between runs
      (finding 5) and command steps (finding 6).
6. **Branding, last.** Bring the brand into the docs on top of item 4. Done
   together with the maintainer, not ahead of time.
