# Product starter

This starter registers one step, `summarize-codebase`, to explain a repository
to a product teammate. It asks the selected CLI harness for a short summary
with file references. It creates no workflows, schedules, or monitors.

Copy `marbles.config.ts` from this folder to your repository root when no config
exists. The Foundry root config was created from this template. Onboarding generates the same prebuilt-step registration.

From the Foundry repository root, run either harness explicitly:

```sh
bun run marbles roll summarize-codebase --harness codex --state .cache/marbles-product-smoke
bun run marbles roll summarize-codebase --harness claude-code --state .cache/marbles-product-claude-smoke
```

Each command requires an installed, authenticated CLI. Add `--dry-run` to check
config loading and harness selection without calling the provider. Without
`--harness`, the step uses Marbles' first detected executor.

The prompt requests read-only inspection of the root README, package manifest,
directory names, and at most six additional files. It asks for no more than
400 words and forbids edits, builds, tests, network tools, and delegation.
These inspection limits are prompt instructions. The request also has a
two-minute timeout, no automatic retries, and propagates step cancellation.
Codex uses its read-only sandbox with automatic approvals disabled. Claude
Code uses its existing permission settings.

To inspect either trial's run history in the dashboard, use its state path:

```sh
bun run marbles --state .cache/marbles-product-smoke
bun run marbles --state .cache/marbles-product-claude-smoke
```
