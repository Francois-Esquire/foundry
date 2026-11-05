# Current information architecture and proposed map

Supporting artifact for [plan.md](plan.md). Inventory taken from the worktree
at `99e225798344a89e1d2841dc84a67e1ca3f7fb1d` (branch
`docs/interactive-documentation`), by reading `docs/blume.config.ts`, every
`meta.ts`, and the frontmatter and headings of every published `.md`/`.mdx`
page. Nothing was built or rendered.

`docs/chronicles/` sits outside Blume's `content.include` globs (`marbles/**`,
`prompts/**`, `spyglass/**`), so these files do not publish.

## Current site

The site is Blume 1.6.3 (Astro 7.3.2 underneath), deployed static to GitHub
Pages under `/foundry`. Three header tabs: Marbles, Spyglass, Prompts. The
home page is a custom `docs/pages/index.astro` with no sidebar. 32 redirects
in `blume.config.ts` preserve older routes.

### Marbles tab (`docs/marbles/meta.ts`)

| Group | Pages, in sidebar order | Lines |
| --- | --- | --- |
| (top) | `index` Introduction | 73 |
| Get Started | `installation`, `quickstart` ("Your first automation"), `using-marbles` | 64, 99, 193 |
| Foundation | `api` ("The Marbles model"), `definitions-and-instances`, `composition`, `contexts`, `workspaces-and-sandboxes`, `agents-and-sessions`, `usage`, `artifacts-and-results`, `durability`, `triggers`, `execution-and-state` (mdx), `primitives` | 83 to 262 each |
| Use Cases | Software Factory (index + Development 7, Maintenance 4, Improvement 5), Evaluations (4), Design (5), Productivity (4) | 34 to 319 |
| Reference | `cli`, `mcp`, `api` (727 lines), `agent-sessions`, `project`, `state`, `safety` (mdx), `troubleshooting`, `remote`, `engine` | 70 to 727 |
| Roadmap | `index`, `deployment` | 68, 192 |
| (bottom) | `contributing`, `first-release` | 166, 34 |

### Spyglass tab

`index`, `start-here`, `examples` (mdx, embeds the real Spyglass viewer of
this repository in an `<iframe>`), Concepts (1), Guides (3), Reference (4),
`contributing`.

### Prompts tab

`index`, `editor` (mdx), `lint` (mdx). Six light/dark PNG pairs under
`prompts/images/`.

### Interactive content today

- Only five pages are MDX: `execution-and-state`, `safety`, `spyglass/examples`,
  `prompts/editor`, `prompts/lint`.
- No `islands/` folder and no `components.ts`. Blume therefore ships no React
  on any page today.
- The one live visual is the Spyglass `<iframe>`, generated at build time by
  `docs/scripts/build-example.ts`.

## Where the six requested journeys live today

| Journey (user requirement) | Pages that serve it now | Gap |
| --- | --- | --- |
| Getting started | `index`, `get-started/*` | Works. `installation.md:19` still says the package is "not yet available from npm"; the prior worktree reported `0.0.1`/`0.0.2` on npm. Not re-verified this round (no network calls). |
| Authoring library | Foundation (12 pages) plus `reference/api` | The content exists but the group is named for concepts, not for the task "write automations". `usage` (model routing) sits mid-sequence. |
| Standalone workflows | `using-marbles#run-once-or-keep-running`, `execution-and-state`, `reference/cli`, `reference/engine` | No single page shows one workflow run by the CLI, by your own program, and by an MCP client. The prior worktree wrote one (`library/one-workflow-three-ways.md`) with a test. |
| MCP | `using-marbles#launch-work-from-an-mcp-client`, `reference/mcp` | Reference is current (task tools present on main). No guide-level page. |
| Software factory | `use-cases/software-factory/**` (17 pages) | No short overview of the loop at the top; the prior worktree drafted "The factory in four steps". |
| Monitoring | `reference/cli#the-dashboard`, `foundation/usage`, `reference/state`, `reference/troubleshooting` | No task-oriented page. The prior worktree drafted `software-factory/monitor.md`. |

Interpretation note. "Authoring library" could mean the authoring API
(`step`, `workflow`, `agent`) or the embedding entry `/lib`. "Standalone
workflows" could mean running workflows without the dashboard, or using
`@foundry/workflows` on its own. The map below assumes the first reading of
each and keeps embedding under "Run and connect". This needs the user's
confirmation.

## Proposed Marbles map (recommendation)

Principle: change grouping and titles before changing URLs. Blume derives
routes from folders, so every move costs a redirect plus heading-anchor
compatibility. Moves are listed explicitly.

```text
Marbles
├─ Introduction                                  index (unchanged)
├─ Get started                                    get-started/
│   ├─ Installation
│   ├─ Your first automation
│   └─ Using Marbles (capability tour)
├─ Write automations        (was Foundation)      foundation/ (title change only)
│   ├─ The Marbles model           [illustration]
│   ├─ Definitions and instances
│   ├─ Steps and workflow composition [illustration]
│   ├─ Execution contexts
│   ├─ Workspaces and sandboxes
│   ├─ Agents and sessions
│   ├─ Artifacts and results
│   ├─ Schedules and monitors
│   ├─ Durability                  [illustration]
│   └─ Foundry primitives
├─ Run and connect          (new folder run/)
│   ├─ One workflow, three ways    NEW  (CLI, your program, MCP client)
│   ├─ Local execution and state   MOVE foundation/execution-and-state
│   ├─ Embed the engine            MOVE reference/engine (+ legacy anchors)
│   └─ Launch from an MCP client   NEW  guide; reference/mcp stays
├─ Monitor and operate      (new folder operate/)
│   ├─ Watch runs and the Feed     NEW
│   ├─ Usage and model choice      MOVE foundation/usage
│   └─ Troubleshooting             MOVE reference/troubleshooting
├─ Use cases
│   ├─ Software Factory   (+ "the factory in four steps" at the top,
│   │                        + Monitor the factory page)
│   ├─ Evaluations, Design, Productivity (unchanged)
├─ Reference  (cli, mcp, api, agent-sessions, project, state, safety, remote)
├─ Roadmap
└─ Contributing, Introducing Marbles
```

Every MOVE needs a `redirects` entry in `blume.config.ts`, inbound link
updates, and pinned anchors (`[#old-id]` or `<a id="old-id"></a>`) where an
old fragment pointed into a section that moved.

Spyglass and Prompts keep their current maps. Spyglass already has a real
render in `examples.mdx`, so it gets no illustration in this plan.

## Journeys as reading paths

Each journey states its entry, its sequence, and where it hands off. "Next"
links at the end of each page should follow these paths, the way
`execution-and-state.mdx` already ends with "Next: Foundry primitives".

| Journey | Entry | Path | Hands off to |
| --- | --- | --- | --- |
| Getting started | Introduction | Installation → Your first automation → Using Marbles | Write automations, or a use case |
| Authoring | The Marbles model | Model → Definitions → Composition → Contexts → (resources: workspaces, agents, artifacts) → Triggers → Durability | Reference: API |
| Standalone workflows | One workflow, three ways | Three ways → Local execution and state → Embed the engine | Reference: CLI, Engine options |
| MCP | Launch from an MCP client | Guide → Reference: MCP | Software Factory (dispatch the factory from a client) |
| Software factory | Software Factory index (four-step summary) | Development chapters in order → Maintenance → Improvement | Monitor the factory |
| Monitoring | Watch runs and the Feed | Feed and dashboard → Usage → State → Troubleshooting | Reference: CLI dashboard keys |
