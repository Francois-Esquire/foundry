# Try the review launch form

The example registers one step, `review-worktree`, when it loads. The
repository's `quirks.config.ts` imports it alongside the Product summary step;
it also loads on its own with `--config apps/quirks/examples/review-with-arguments.ts`.

From the monorepo root:

```sh
bun run quirks -- --dry
```

Enter the dashboard, press `2` for Catalog, select `review-worktree`, and press
`l`. The form comes from the step's `.input(schema)`:

| Control | Example |
| --- | --- |
| Worktree | `.` for this checkout, or `../my-feature` for another existing checkout |
| Target | `apps/quirks` relative to the selected worktree |
| Scope | `changes`, `staged`, or `code` |
| Focus | Check cancellation and error handling |
| Max findings | `3`, with a range of 1 to 10 |
| Include tests | On to read tests and flag coverage gaps |
| Security | On to inspect validation, permissions, and sensitive data handling |

Use Tab and Shift+Tab to move between controls. Press Ctrl+Enter or click Launch.
The dashboard selects the new run; Enter opens its details. Under `--dry`, agent
turns are echoed without invoking Codex or Claude Code.

For an actual review, start with `bun run quirks -- --harness codex` or
`bun run quirks -- --harness claude-code`. The selected checkout becomes the
agent's working directory. This example requests a read-only review of at most
eight files, with a two-minute timeout. It returns the report in the run output
and does not create a worktree or write a report file. Include tests means read
them, not execute them.

The same step accepts arguments without the dashboard:

```sh
bun run quirks -- once review-worktree --dry --input '{"worktree":".","target":"apps/quirks","scope":"changes","focus":"Check cancellation and error handling","maxFindings":3,"includeTests":true,"security":false}'
```
