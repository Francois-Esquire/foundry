# Context Map

## Contexts

### Primitives

- **Core** (`packages/core`): shared kernel of identifiers, error contracts, and cross-context reference protocols
- **Lib** (`packages/lib`): application-agnostic utilities shared across contexts

### Tools / Engines

- [Prompts](./packages/prompts/CONTEXT.md): reads, checks, and writes prompts across CLI harness dialects
- [Usage](./packages/usage/CONTEXT.md): observes and reports provider account limits, consumption, charges, and spend
- **Models** (`packages/models`): unified model catalog and provider access across remote providers and CLI harnesses

### Domains

- **Workspaces** (`packages/workspaces`): durable catalog over an authoritative workspace source
- **Artifacts** (`packages/artifacts`): stable artifact identity, versioned content, and directly usable files
- **Tasks** (`packages/tasks`): task backlog tracking what there is to do, what is ready, and what is done
- **Modules** (`packages/modules`): workspace module contracts, registry, packaging, and composition
- **Agents** (`packages/agents`): agent harnesses, sessions, authorization, skills, and tools
- [Sandbox](./packages/sandbox/CONTEXT.md): portable, OS-agnostic sandbox execution surface and durable container orchestration across local, cloud, and virtual drivers
- **Workflows** (`packages/workflows`): multi-step durable workflows and step hooks
- [Queue](./packages/queue/CONTEXT.md): durable job execution, concurrency pools, retries, leases, and suspensions
- [Scheduling](./packages/scheduling/CONTEXT.md): recurring and future schedules that dispatch each due occurrence once

### Applications

- **Marbles** (`apps/marbles`): composable local automation host with agent judgment
- **Works** (`apps/works`): Foundry Works desktop application for authoring and running workspace modules
- [Spyglass](./apps/spyglass/CONTEXT.md): scans TypeScript workspaces into structural datasets, lenses, and viewers

## Relationships

- **Domains → Tools / Engines → Primitives**: dependency direction is strictly acyclic across tiers (`Primitives` ← `Tools / Engines` ← `Domains`); tools never depend on domains, and shared contracts move down to `Core`
- **Core (Shared Kernel)**: provides shared primitives to every context; `@foundry/core/agents` holds the reference vocabulary shared among `Prompts`, `Agents`, and `Models`
- **Workspaces → Artifacts → Modules**: `Artifacts` gives stable identity and versioned content to entries cataloged by `Workspaces`; `Modules` composes `Artifacts` and `Sandbox` into runnable workspace modules
- **Scheduling → Queue → Workflows**: `Scheduling` claims due occurrences and dispatches them as jobs into `Queue`; `Workflows` executes multi-step `Workflow` and `Step` runs on `Queue` through a queue handler
- **Marbles → Domains, Tools / Engines**: composes `Workspaces`, `Artifacts`, `Tasks`, `Agents`, `Sandbox`, `Queue`, `Scheduling`, `Workflows`, `Models`, `Prompts`, and `Usage` behind local host facades
- **Works → Artifacts, Modules, Sandbox**: composes workspace modules, artifacts, and sandboxes into a desktop host
- **Spyglass → Workspaces (scanned subjects)**: analyzes TypeScript workspaces read-only into datasets, projections, and lenses
