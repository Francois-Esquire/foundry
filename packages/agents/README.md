# @foundry/agents

The agent runtime: a tool-calling loop over an AI SDK language model, a
persisted conversation, MCP servers, skills, and an authorization gate on every
tool call. The package depends on no model registry: it takes a model.

## Quick start

```typescript
import { SessionHarness } from "@foundry/agents/harness";

const harness = new SessionHarness({
  model, // any LanguageModelV4; see "The model" below
  instructions: "You are a helpful assistant.",
  sessionId: "session-1", // omit for a fresh id
});

const stream = harness.stream("What changed in the last release?");

for await (const event of stream) {
  if (event.type === "text-delta") process.stdout.write(event.delta);
}

console.log(await stream.usage);
```

That is the whole 80% path. History persists to an in-memory store, tool calls
run through a permissive authorizer, and the next turn on the same harness sees
the first. To resume across harnesses, share a `store` and reuse the
`sessionId`.

Everything else in this package is a swap on one of those defaults: a real
`store`, a real `policy`, more `tools` (skills, todos, MCP servers),
`compaction`.

## How it comes together

Four layers, each wrapping the one below. Import at the level you need — a CLI
probably wants `AgentHarness`, an app wants `SessionHarness`.

```
LoopAgent          one turn: run the tool loop over one model, observe cost
  AgentHarness     + tools — whatever you compose (skills, todos, MCP), behind the authorization gate
    SessionHarness + a conversation — identity, history, persistence, compaction
      transport    + a wire — the turn projected as UI chunks for a subscription
```

Three more pieces cut across all four rather than sitting in the stack:

- **`authorization`** decides whether a tool call may run. Every tool compiled
  by a harness is gated, whatever source contributed it.
- **`session`** is the record vocabulary — messages, parts, usage, the store
  interface. It names no database.
- **`contexts`** estimates window usage and supplies provider cache directives.
  Session compaction handles folding long conversations.

A turn, end to end:

1. `SessionHarness.stream(input)` validates any approval responses in the
   input, creates the session in the store if it is not there yet, and appends
   the input.
2. With `compaction` set, `contexts` sizes the active history against the
   model's window and folds older messages under a summary when it is over the
   high-water mark.
3. History is read back — the active view, summary first, when the store
   supports it — converted to model messages, and the provider's cache
   directives are applied.
4. The `AgentHarness` built at construction streams the turn through its
   `LoopAgent`. Model and tools are fixed per harness.
5. Each tool call is checked against the authorizer, then executed through the
   effect port. A denial comes back as an ordinary tool result the model can
   read and route around — not a thrown error.
6. Stream parts are mapped to `SessionEvent`s and accumulated into one
   `SessionMessage`, which is persisted when the stream drains.

---

## `@foundry/agents/harness`

The composition layer. Start here.

### `new SessionHarness(settings, context?)`

```typescript
type SessionHarnessSettings = AgentHarnessSettings & {
  store?: SessionStore; // default: InMemorySessionStore
  compaction?: CompactionSettings; // auto-fold history when the window fills
  registry?: AgentCompatibilityRegistry; // default: a fresh one
  mesh?: Mesh; // default: createMesh({ registry, store })
  nodeId?: string; // default: "primary"
};

type TurnContext = { sessionId: string };
```

The session id is fixed at construction: `settings.sessionId`, else
`context.sessionId`, else a fresh UUID. The session record is created in the
store on the first turn unless the host already filed it. `SessionHarness`
composes an `AgentHarness` rather than extending it, and adds the mesh's
`list_agents` and `message_agent` tools to yours.

```typescript
harness.stream(input: SessionInput, opts?: SessionStreamOptions): SessionStream
harness.generate(input: SessionInput, opts?: SessionStreamOptions): Promise<SessionMessage>

type SessionStreamOptions = { signal?: AbortSignal } & StreamHandlers;
```

`SessionInput` is a string or `{ parts }`. Every call is persisted; when the
caller owns history, use `AgentHarness` directly.

The returned `SessionStream` is async-iterable and carries its finals:

```typescript
interface SessionStream extends AsyncIterable<SessionEvent> {
  readonly text: Promise<string>;
  readonly usage: Promise<SessionUsage>;
  readonly message: Promise<SessionMessage>;
  readonly outcome: Promise<"complete" | "awaiting-approval">;
}
```

Iterate it, tap `StreamHandlers`, or just await a promise. Any combination.

**Compaction** is opt-in and best-effort — it needs a summarize-aware store and
never breaks a turn if it fails:

```typescript
compaction: {
  summarizer: createModelSummarizer({ model: cheapModel }),
  model: { id: "big-model", contextWindow: 200_000 }, // omit to size by the turn model's own limits
  keepTokens: 20_000, // recent history left unfolded; default: half the headroom
}
```

### `new AgentHarness(settings, context?)`

The same thing without a conversation. Use it when the caller owns history.

```typescript
type AgentHarnessSettings = Omit<LoopAgentSettings, "toolsContext"> & {
  toolsContext?: Record<string, unknown>; // the one object every tool receives as `context`
  sessionId?: string; // fixed at construction; default: context.sessionId, else a fresh UUID
  policy?: AgentAuthorizer; // default: fully permissive
  effectPort?: ToolEffectPort; // default: direct in-process
  permission?: HarnessPermissionCallback; // live approval, claimed before execution
  agentId?: string; // default: "agent"
  agentGeneration?: number;
};
```

`LoopAgentSettings` is the AI SDK's `ToolLoopAgent` settings (`instructions`,
`tools`, `stopWhen`, …) with an `AgentModel` and an optional `observe`.

`toolsContext` is handed to every tool unchanged — the same object, not a copy,
so a host may freeze or brand it. The harness attaches its `policy` beside it
(read back with `getPolicy` from `@foundry/agents/tools/context`) rather than
writing a field onto it.

```typescript
const { result, parts } = await harness.stream({ messages });
const output = await harness.generate({ messages });
```

`stream` returns the SDK's `StreamTextResult` as `result`, and `parts`: an
`AsyncIterable<StreamPart>` with each tool call stamped with its registration
provenance and each approval request with its derived capability. `StreamPart`
is the AI SDK's `TextStreamPart<ToolSet>` with those two members widened, plus
`HarnessStreamPart` (`harness-activity`, `harness-tool`,
`harness-approval-request`) emitted by driver sessions.
`transformStream(parts, options)` turns them into a `SessionStream`; that is
what `SessionHarness` does. `generate` returns the SDK result as is.

`tools` is the whole tool surface, as one AI SDK `ToolSet`. Compose it yourself
from whatever sources apply — `registry.tools` from a skill registry,
`createTodos().tools`, MCP tools — and join their instructions the same way.
`composeTools` from `@foundry/agents/tools/compose` merges maps and throws on a
duplicate name.

### Tagging a tool

A tool can carry `ToolMeta` — its source, how a call's capability is derived
from its input, and where its effect runs. The compiler preserves your schema,
metadata, and any existing `needsApproval`, and adds the authorization check
and the effect boundary. An untagged tool is `declared` with the generic
`tool.call` capability; a tool without `execute` passes through uncompiled.

```typescript
import { tagTool, tagTools } from "@foundry/agents/harness";

const fetchDocs = tagTool(fetchDocsTool, {
  capability: () => ({ kind: "web.fetch", domain: "docs.example.com" }),
});
const deployTools = tagTools({ rollback: rollbackTool }, "module");

const harness = new AgentHarness({
  model,
  tools: { fetchDocs, ...deployTools },
});
```

The source is what an audit trail and a per-source policy key on.

### `createBuiltinCodingHarness(settings, context) => HarnessSession`

A `SessionHarness` for coding work: `CODING_INSTRUCTIONS` prepended to yours,
`stopWhen` derived from `maxSteps`, and one turn at a time behind an
interruptible gate (no live steering). The host supplies the coding tools and
must set `agentId`, `policy`, `tools`, `compaction`, and `maxSteps`.

### `createDriverSession(settings, driver) => HarnessSession`

Runs an external CLI harness — a `HarnessTurnDriver` — behind the same
`HarnessSession` surface. Its native activity, tool events, and approvals are
persisted to `settings.store`, and its permission requests are decided against
`settings.policy` (asking the host's `approve` callback when one is set).
Requires `agentId`, `policy`, `profile`, `store`, and `model` (a `ModelRoute`).

---

## `@foundry/agents/session`

The conversation's vocabulary and its persistence seam. No database appears
anywhere in it.

### The record

```typescript
type SessionRole = "user" | "assistant" | "system" | "tool" | "summary";

type SessionPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "image"; url: string; mediaType?: string }
  | { type: "tool_call"; toolCallId: string; name: string; input: unknown; providerOptions?: …; provenance?: ToolProvenance }
  | { type: "tool_result"; toolCallId: string; output: unknown; isError?: boolean }
  | { type: "error"; message: string }
  | { type: "tool_approval_request"; approvalId: string; capability: Capability; … }
  | { type: "tool_approval_response"; approvalId: string; approved: boolean; … }
  | { type: "harness_activity" | "harness_tool" | "harness_session" | "harness_question"; … };

interface SessionMessage {
  id: string; sessionId: string; role: SessionRole;
  parts: SessionPart[]; status: "streaming" | "complete" | "error";
  metadata?: MessageMetadata; summarized?: boolean;
  createdAt: number; updatedAt: number;
}
```

Parts are the persisted form of _everything_ a turn emits, not just final text,
so a transcript reconstructs exactly.

### The store

```typescript
interface SessionStore {
  createSession(input?: CreateSessionInput): Promise<SessionRecord>;
  getSession(id: string): Promise<SessionRecord | null>;
  updateSession(
    id: string,
    patch: UpdateSessionInput,
  ): Promise<SessionRecord | null>;
  appendMessage(input: CreateMessageInput): Promise<SessionMessage>;
  updateMessage(
    id: string,
    patch: UpdateMessageInput,
  ): Promise<SessionMessage | null>;
  listMessages(sessionId: string): Promise<SessionMessage[]>;
}
```

To back a session with a real database, extend `AbstractSessionStore` — it
supplies the shared summarize and active-view behaviour so every store folds
history identically. `InMemorySessionStore` is the zero-config default and the
reference implementation any persistent store must match.

Override `summarize` when you do. The base implementation appends the summary
and flips each folded message in a loop, which is only safe in memory; a real
store must commit both as one transaction or the next compaction reads a
corrupt history.

### Events

```typescript
type SessionEvent =
  | { type: "text-delta"; delta: string }
  | { type: "reasoning-delta"; delta: string }
  | {
      type: "tool-call";
      toolCallId: string;
      name: string;
      input: unknown;
      provenance?: ToolProvenance;
    }
  | {
      type: "tool-result";
      toolCallId: string;
      output: unknown;
      isError?: boolean;
      preliminary?: boolean; // an interim result from a generator tool
    }
  | ({ type: "tool-approval-request" } & AgentApprovalRequest)
  | { type: "harness-activity"; event: HarnessActivityEvent }
  | { type: "harness-tool"; event: HarnessToolEvent }
  | { type: "error"; error: Error }
  | { type: "finish"; message: SessionMessage; usage: SessionUsage };
```

### Compaction

```typescript
compact(…)                    // fold history under a summary, once
maybeCompact(…)               // fold only if the window says to
createModelSummarizer(opts)   // wrap a cheap model as a Summarizer
renderTranscript(messages)    // messages → the text a summarizer reads
toModelMessages(messages)     // session records → AI SDK ModelMessages
```

---

## `@foundry/agents/authorization`

The gate. This module owns what a capability _is_; the mechanism — the
Authorizer, Grants, Policy tiers — lives in `@foundry/lib/config/authorization`
and knows no agent vocabulary.

```typescript
type Capability =
  | { kind: "web.fetch"; domain: string }
  | { kind: "mcp.tool"; serverId: string; tool: string }
  | { kind: "fs.read"; projectId: string; root: string }
  | DomainCommandCapability // kind: "domain.command"
  | { kind: "tool.call"; source: ToolSource; tool: string };
```

```typescript
const { authorizer } = createInMemoryAgentAuthorizer({
  policy: { global: "ask", byKind: { "fs.read": "allow", "tool.call": "ask" } },
});

const harness = new AgentHarness({ model, policy: authorizer });
```

`createInMemoryAgentAuthorizer` is the reference composition, with
`allow`/`revoke` helpers over its Grant repository. A host with real storage
calls `createAgentAuthorizer({ grants, policy })`; with no `policy` it falls
back to `AGENT_ASK_BY_DEFAULT`, which asks for everything.

Two properties worth knowing before you configure it:

- **`tool.call` never inherits the global tier.** It is the unclassified
  fallback, so a blanket `"allow"` must not reach it. Set it explicitly in
  `byKind`, or every untagged tool is denied.
- **Without a `permission` callback, `decide` runs twice per call, `claim`
  once.** The check is repeatable and consumes nothing, so it can run in the
  SDK's `needsApproval` predicate _and_ in the defensive re-check inside
  `execute`. Authority is spent only by `claim`, immediately before the effect,
  keyed by a stable `invocationId` so a replayed continuation re-runs against
  its own claim.

`explainCapability` is the human framing an approval dialog shows;
`describeCapability` is the flat line an audit log wants. This entry is
renderer-safe — it re-exports only what stays pure, so a UI can import it.

---

## `@foundry/agents/skills`

A skill is a named capability the model loads on demand: a description it routes
on, instructions it reads when it commits, and files it opens one at a time.

```typescript
interface Skill {
  name: string; // kebab-case; re-adding a name replaces it
  description: string; // the routing signal — one line
  instructions?: string; // returned by load_skill
  files?: Record<string, string | Uint8Array>;
}
```

```typescript
const registry = createSkillRegistry([defineSkill(source)]);

registry.tools; // list_skills + load_skill
registry.instructions; // the catalog, for the system prompt
registry.get(name); // registry.list() for all of them
registry.add(...skills).remove(name);
```

Spread `registry.tools` into a harness's `tools` and append
`registry.instructions` to its instructions, and the model gets the catalog and
the loaders together. Bundles stay in memory — the registry holds no paths.

---

## `@foundry/agents/agents/*`

The primitives everything above composes. Reach for these when the harness is
more than you need, or when you are building multi-agent topology.

```typescript
// ./agents/model
interface AgentModel extends LanguageModelV4 {
  route?: { id: string; provider?: string; harness?: string };
  limits?: { contextWindow?: number; maxOutputTokens?: number };
}
type ObserveTurn = (turn: { sessionId; model: ModelRoute }) => TurnObservation | null;

// ./agents/loop-agent
class LoopAgent extends ToolLoopAgent
new LoopAgent(settings, { sessionId })
```

### The model

A harness takes one `AgentModel` at construction. A raw AI SDK model works; a
host registry hands back one that also declares its `route` (the ids recorded
on every message, so a session resumes on the same one) and its `limits` (the
window compaction sizes to). Nothing here resolves ids to models: the host does
that once, and a per-turn change is a new harness with a different model.

`observe` on the settings opens one observation per call; the agent wraps the
model with it and settles it from the call's telemetry hooks (end, abort, or
error), not on `onFinish`. `@foundry/models` ships `observeAgentTurn` in
exactly this shape.

```typescript
// ./agents/registry
createAgentRegistry(); // preset catalog: id + generation → AgentPreset
createAgentCompatibilityRegistry(); // id → live agent, for meshes and agent tools

// ./agents/agent-tool
createAgentTool(config); // any agent, as a callable tool
```

`createAgentTool` resolves subagents by string id at call time, so a parent
never holds a direct reference. With both a conversation store and a space —
from its config or from the tool context's `conversations` and `space` — it
loads the thread's prior history, streams the subagent's reply, and appends the
exchange back.

```typescript
// ./agents/mesh
createMesh(opts)   // → Mesh; peers get list_agents / message_agent
HUMAN              // the symbol for the human node

// ./agents/spawn
createSpawnTool(deps)   // undefined at the depth limit

// ./agents/resolve
createAgentPreset(spec, surface)   // → AgentPreset: createAgent(ctx) / createSession(ctx)
resolveAgent(spec, surface, ctx?)  // → Promise<SessionHarness>, in one step
```

Peers talk over the ordinary tool loop. `createSpawnTool` delegates to a child
session whose `recursionDepth` is frozen at spawn; at the depth limit the tool
is withheld, so the model never sees it.

An `AgentSpec` declares an agent — `id`, `prompt`, and the `tools`, `skills`,
and `mcp` it wants by catalog name. The `AgentSurface` resolves those names;
its `model` resolver is the only one required. Pass a factory instead of a
surface to bind settings in code.

---

## Local checks

Tests live in `src/test/`; shared helpers live in `src/test/helpers/`.
Run `bun run test`, `bun run typecheck`, and `bun run build` from this package.
Lint and formatting are owned by the repository root.
