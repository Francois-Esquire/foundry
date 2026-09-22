# Try the review launch form

The repository's `quirks.config.ts` opts into `reviewWithArguments()` alongside
the Product summary step. Importing the example alone registers nothing.

From the monorepo root:

```sh
bun run quirks --dry
```

Enter the dashboard, press `2` for Catalog, select `review-worktree`, and press
`l`. Fill in the form:

| Control | Example |
| --- | --- |
| Worktree path | `.` for this checkout, or `../my-feature` for another existing checkout |
| Where should we review? | `apps/quirks` relative to the selected worktree |
| What should we look at? | Uncommitted changes, staged changes, or code as it stands |
| Anything on your mind? | Check cancellation and error handling |
| Maximum findings | `3`, with a range of 1 to 10 |
| Inspect tests | On to read tests and flag coverage gaps |
| Security pass | On to inspect validation, permissions, and sensitive data handling |

Use Tab and Shift+Tab to move between controls. Press Ctrl+Enter or click Launch.
The dashboard selects the new run; Enter opens its details. Under `--dry`, model
calls are echoed without invoking Codex or Claude Code.

For an actual review, start with `bun run quirks --harness codex` or
`bun run quirks --harness claude-code`. The selected checkout becomes the model's
working directory. This example requests a read-only review of at most eight
files, with a two-minute timeout. It returns the report in the run output and
does not create a worktree or write a report file. Inspect tests means read them,
not execute them.

The same step accepts arguments without the dashboard:

```sh
bun run quirks once review-worktree --dry --input '{"worktree":".","target":"apps/quirks","scope":"changes","focus":"Check cancellation and error handling","maxFindings":3,"includeTests":true,"security":false}'
```
