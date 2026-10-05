# Marbles roadmap

Maintainer note, excluded from the Blume site. The agreed order of the next
pieces of work; each step lands before the next starts.

1. **Streaming runs and the agent work step.** A stream interface in
   `@foundry/workflows` that carries a run's live output. A prebuilt agent work
   step that writes to it and chooses its harness (Codex, Claude Code, or the
   built-in `@foundry/agents` harness) through the models package rather than
   detected command-line executors. Sessions stay in memory: the built-in
   harness keeps messages; Codex and Claude Code keep only a session id, with no
   stored messages or compaction unless explicitly requested.
2. **Rebuild the library against `_api-alt.md`.** Nothing is published, so
   the public API can change freely. In order:
   1. Understand the current API and the packages under it.
   2. Build the internals: the wrapper that drains children before the body,
      the context keys, composition, trigger state.
   3. Build the outermost API: the eight top-level words and the builder.
   4. Redesign the library around them. Open items live in the API doc's
      "Open" section and the gap map.
3. **Companion skill.** A top-level `skills/` directory of project skills,
   installable with Vercel's `skills` CLI. The first skill helps an agent set
   up a `marbles.config.ts`; written against the cleaned-up API. Landed
   2026-09-25 as `skills/marbles-config`: a procedure, an API reference, and
   the hand-off patterns the API doc promises. Its eval loop (baselines,
   description tuning) is a follow-up.
4. **Docs and use cases.** A guided walkthrough, "The Software Factory": the
   software lifecycle as inputs, marbles, and outputs. Landed 2026-09-28 as
   `walkthroughs/software-factory.mdx`, built on the complete config below.
   Then walkthroughs for productivity and creativity, still open. Further
   docs work stays an open bucket.
5. **Branding, last.** Bring the brand into the docs on top of step 4. Done
   together with the maintainer, not ahead of time.
