# Quirks CLI to-dos

Status: all items implemented and verified, including final live dashboard scenarios with both harnesses.

## 1. Remove defaults

- [x] Remove automatic registration of the current built-in definitions at CLI startup.
  - A fresh workspace should not acquire steps, workflows, schedules, or monitors implicitly.
  - Load only definitions explicitly configured by the user.
  - Preserve existing saved run history.
- [x] Distinguish missing config, valid empty config, and config load failure.
  - Do not report “Config loaded” when no config exists.
  - A valid empty config should remain a supported state.
- [x] Update examples, documentation, and tests that assume defaults are registered.

## 2. Export prebuilt steps

- [x] Make reusable capabilities available as opt-in, configurable steps.
  - Use “prebuilt” terminology; decide exact export names during implementation.
  - Users select and configure steps in `quirks.config.ts`.
  - Importing the module must not register the entire collection.
  - Configuring a step must not execute it.
  - Users compose workflows, schedules, and monitors explicitly.
- [x] Review the existing definitions for repackaging.
  - Consider implementation, review, worktree review, and session review as reusable steps.
  - Keep development workflow compositions as explicit examples where useful.
  - Do not automatically populate the catalog with those compositions.
- [x] Wire exports through the package and config loader.
  - Keep CLI and config imports connected to the same registry.
  - Support installed-package usage as well as repository development.
- [x] Verify opt-in behavior and packaging.
  - Import alone leaves the registry unchanged.
  - Selecting one step registers only the intended definition.
  - An isolated consumer can import and configure the shipped prebuilt steps.

## 3. Add onboarding and empty states

- [x] Design onboarding for a workspace with no config file.
  - Preferred reference: [termcn Setup Flow](https://www.termcn.dev/docs/templates/ink/setup-flow).
  - Used the available OpenTUI Setup Flow and Select variants, adapted to Gruvbox and scoped keyboard/mouse input.
  - Preserve the Gruvbox theme and polished, centered presentation.
  - Existing valid configs continue through the normal startup flow.
  - Config load errors should be shown as errors, not treated as missing config.
- [x] Offer the three confirmed starter templates.
  - Developer: code review.
  - Design: prototype.
  - Product: summarize this codebase.
- [x] Generate `quirks.config.ts` with selected steps only.
  - Leave workflows and triggers for the user to compose later.
  - Setup configures step name, additional instructions, and an optional harness. Prototype accepts a brief and returns HTML/CSS in its response.
  - Keep setup simple; defer agent-assisted configuration authoring.
- [x] Define the setup interactions before implementation.
  - Implemented sequence: template selection, step settings, config review, creation, dashboard.
  - Define back, cancel, and skip behavior.
  - Write only when setup is completed; never silently overwrite an existing config.
  - Respect the selected config path and surface write or load failures.
  - Support keyboard and mouse interaction, clear focus, and smaller terminals.
- [x] Keep the setup composition separate from runtime and filesystem operations.
  - Build reusable presentational components and blocks inside `components/`.
  - Keep config discovery, draft validation, file creation, and loading in the host layer.
  - Leave a clear extension point for future agent-assisted setup.
- [x] Add reusable, actionable empty states.
  - Catalog: no configured steps or workflows; explain how to add them.
  - Triggers: no schedules or monitors; explain explicit configuration.
  - Runs: no history; distinguish no triggers from waiting for configured triggers.
  - Filters: no matches; provide a clear way to reset filters.
- [x] Add preview scenarios and focused verification.
  - Missing config and valid empty config.
  - Configured steps without triggers, and configured triggers without runs.
  - Filtered lists with no matches.
  - Setup navigation, cancellation, and config write/load errors.
  - Generated config loads successfully without automatic execution.
  - Existing config is preserved, including one created while setup is open.

## 4. Launch workflows from the catalog

- [x] Add a Launch action for the selected workflow.
  - Make it available from the catalog detail/menu opened with Enter or a click.
  - `l` launches the selected catalog item; details also expose a clickable Launch action.
  - Support the same launch flow from the dashboard catalog and the launch menu.
- [x] Use the existing one-off execution behavior.
  - The current CLI command is `quirks once <name> [--input json]`.
  - Reuse the workflow execution path behind that command within the running app.
  - Keep the dashboard open and schedules and monitors active during a manual run.
  - Do not create a schedule or monitor as a side effect of launching.
- [x] Branch the launch flow according to the workflow's declared arguments.
  - No arguments: start immediately when Launch is activated.
  - Arguments: show a form, validate the values, then launch on submission.
  - Cancel returns to the catalog without starting a run.
- [x] Define runtime argument metadata alongside workflow configuration.
  - The current registration API uses TypeScript input types; those alone cannot generate runtime controls.
  - Include field names, labels, descriptions, required/optional status, and defaults.
  - Keep UI controls mapped to the workflow's actual input values.
  - Distinguish a declared no-argument workflow from one with unknown input requirements.
  - Decide how to handle missing metadata or unsupported types without silently launching with invalid input.
- [x] Use termcn controls compatible with OpenTUI for a small initial set of argument types.
  - Supported types: text, multiline text, numbers, booleans, and a choice from fixed options.
  - Adapted termcn Select for choices and booleans; OpenTUI input/textarea handle text and numbers.
  - Show field validation errors and preserve entered values after a failed submission.
  - Preserve meaningful values such as `false`, `0`, and omitted optional fields.
  - Defer arbitrary nested objects, unions, and collection editors.
- [x] Return to the dashboard once the run is accepted.
  - Show and select the new item in Runs, with access to its details and active step.
  - Make the new run visible even if the previous run filter would hide it.
  - Update progress and completion through the existing runtime snapshot mechanism.
  - Keep the interface responsive while the workflow runs.
  - Show launch failures clearly and prevent duplicate submission while launch is pending.
- [x] Keep launch components presentational and execution in the host layer.
  - Reuse form controls and input validation across launch entry points.
  - Keep workflow argument metadata independent of terminal component types.
- [x] Add preview scenarios and focused verification.
  - No-argument launch and a workflow with each supported field type.
  - Defaults, optional fields, invalid input, cancellation, and launch failure.
  - Keyboard and mouse activation, including repeated submission while pending.
  - A real manual run appears in Runs and progresses without stopping active triggers.

## 5. Try the Product starter in this monorepo

- [x] Create a Product config template with one `summarize-codebase` step.
  - Generate the repository's `quirks.config.ts` from it.
  - No schedules, monitors, or automatic execution.
  - Keep the summary short and codebase inspection read-only and bounded.
- [x] Repeat the final scenario through the real dashboard with both Codex and Claude Code.
  - Use `--harness` to exercise each integration independently.
  - Keep live provider calls separate from the default test suite.
  - Record actual successes or blockers without treating a dry run as live evidence.
  - Both completed successfully on 2026-09-22 after allowing normal local CLI access.
  - Codex run: `rn-d430afe7-1f74-455b-88b5-919cf7c3f376` in `.cache/quirks-product-smoke`.
  - Claude Code run: `rn-b4438cd4-51b6-42a3-ac67-84001a7612c7` in `.cache/quirks-product-claude-smoke`.
  - Dry runs for both harnesses, Quirks typechecking, and scoped lint/format checks passed.

## Verification

- Build: `bun run build --filter=@foundry/quirks` passed.
- Quirks: 83 unit tests and 53 terminal/component tests passed.
  - Real PTY coverage includes setup creation/skip, config errors, no-argument launch, argument launch, and schedules continuing during manual work.
  - Input coverage includes false, zero, omitted values, defaults, validation errors, unsupported metadata, cancellation, and pending-submission guards.
  - Short-terminal focus scrolling and keyboard/mouse navigation are covered.
- Package: 2 isolated package tests passed, including local and global prebuilt imports, shared registry behavior, declarations, and real terminal startup.
- Repository lint/format, dependency consistency, and all workspace typechecks passed.
- Repository-wide `validate` still stops at pre-existing Knip findings: `@foundry/core` and seven unused exported types. New runtime config/template/example entry points are declared in `knip.json`.
- Docs validation still reports the unchanged `docs/index.md` link to `../CONTRIBUTING.md`.
- Root `quirks.config.ts` starts with the Product summary step and opts into the `review-worktree` argument-form example.
- The review example passed three focused tests, Quirks typechecking, scoped lint, a CLI dry run, and a real terminal form/launch smoke check.
- Final live Codex dashboard scenario passed: `rn-59073864-11f2-49d9-914e-1c127ed7b3df`.
  - The scenario waited at the splash, launched from Catalog, verified exactly one saved completed run and its harness output, opened run details, and quit cleanly.
- Final live Claude Code dashboard scenario passed: `rn-12b15bec-bdbe-4168-9966-a2f145ca2a19`.
  - Verified the same startup, launch, output, persisted run, details, and clean shutdown path as Codex.
- Final receipts are `.cache/quirks-final-codex.json` and `.cache/quirks-final-claude-code.json`; each records the state path and returned summary.
