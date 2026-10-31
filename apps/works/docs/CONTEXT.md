# Works harness context

Works is the local harness for authoring and running Modules and working with Artifacts.
Framework terms come from the [Modules glossary](../../../packages/modules/GLOSSARY.md)
and [Artifacts contracts](../../../packages/artifacts/README.md). Use their definitions
for Module, Artifact, Content, Version, Installation, Program, Capability, Grant,
Invocation, Development session, and Runtime session. The existing UI label **Releases**
refers to Versions; it introduces no entity.

## Authoring and editing

**Draft**: Unsaved source edits based on a known Development source binding.

**Authoring conversation**: A conversation about changing one Module and its Draft.

**Agent Session**: The agent framework's conversation and message history.
Distinguish from a Gateway Development session or Runtime session.

**Edit proposal**: Suggested source changes relative to a captured Draft, awaiting
acceptance. Acceptance changes the Draft; saving commits it.

**File Artifact**: An Artifact whose primary output is an addressable file, such
as a Markdown document. That file belongs to Content.

**Editor registration**: A Module's declaration of the Artifact types a named
View can open for reading or editing.

**Editor binding**: The association between one opened Artifact entry and its
selected editor View, owned by a runtime that may have several bindings.

**Access scope**: The set of resources and actions authorized for a caller.

**System slice**: A bounded, read-only selection of host-owned system state
shared with a Module.

**Module setting**: A per-Module dot-notation key declared through the Foundry
Manifest and set per Module, capped by host ceilings. Settings express limits
and preferences. A Module that is on keeps its sandbox on even when idle; no
idle timeout may override that rule. Network, broader Artifact access and host-operation authority
are Grants, shown and revocable in Access.

## Execution and evidence

**Registered workflow**: A host-provided workflow that an authorized Module can
request by its registered identity and version.

**Execution activity**: Evidence of work performed by Works-owned engines and
runtimes, including agentic work, workflow executions, builds, and Program lifetimes,
and evidence of failed save attempts by people or agents.

**Execution Run**: The execution engine's durable run, on a named Queue,
containing Agent Session generate/stream work with start, progress and terminal
outcome correlated to its Module and Agent Session. Works keeps no wrapper Run.
The engine is required and starts before saves or launches; startup failure is
a Works startup failure. All documented actions use this model; builds and
Program lifetimes target it.
A Program run stays running until stop and becomes interrupted after a crash.
The **Execution Runs** tab reads engine runs, including failed-save attempts.

**Queue**: A named FIFO engine queue. `system` has unbounded length; unlimited
means admission, not concurrency. Requests are never rejected for queue capacity,
and saves to the same Module stay in request order. Other queues have concurrency
configurable through Module settings and no length caps. Concurrency bounds active
work separately from sandbox ownership and machine resource ceilings.

**Call observation**: Evidence of a model turn, tool call, or Gateway Invocation,
identified by its source kind.

**Artifact save**: A committed in-place edit of working Artifact files, recorded
with origin in the engine run store, which supplies save history. A
release/freeze is a separate action; an edit
proposal or failed attempt is not a save.

**Save origin**: Attribution of a save to its actor and, when known, its Module,
request, Agent Session, and Execution Run when applicable.

**Audit observation**: Retained evidence of an action or outcome, distinct from
authority to perform it.
