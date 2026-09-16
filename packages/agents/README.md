# @foundry/agents

The agent runtime: a tool-calling loop over an AI SDK language model, a
persisted conversation, MCP servers, skills, and an authorization gate on every
tool call. The package depends on no model registry: it takes a model.

## Quick start

```typescript
import { createSessionHarness } from "@foundry/agents/harness";

const harness = await createSessionHarness(
  {
    model, // any LanguageModelV4; see "The model" below
    instructions: "You are a helpful assistant.",
  },
  { sessionId: "session-1" },
);

const stream = harness.stream("What changed in the last release?");

for await (const event of stream) {
  if (event.type === "text-delta") process.stdout.write(event.delta);
}

console.log(await stream.usage);
```

That is the whole 80% path. History persists to an in-memory store, tool calls
run through a permissive authorizer, and the second turn on the same
`sessionId` sees the first.

Everything else in this package is a swap on one of those defaults: a real
`store`, a real `policy`, `mcp` servers, `skills`, `compaction`.

## How it comes together

Four layers, each a strict superset of the one below. Import at the level you
need — a CLI probably wants `AgentHarness`, an app wants `SessionHarness`.

```
LoopAgent          one turn: resolve a model, run the tool loop, observe cost
  AgentHarness     + tools — MCP, skills, todos, and the authorization gate
    SessionHarness + a conversation — identity, history, persistence, compaction
      transport    + a wire — the turn projected as UI chunks for a subscription
```

Three more pieces cut across all four rather than sitting in the stack:

- **`consent`** decides whether a tool call may run. Every tool compiled by a
  harness is gated, whatever layer registered it.
- **`session`** is the record vocabulary — messages, parts, usage, the store
  interface. It names no database.
- **`contexts`** estimates window usage and supplies provider cache directives.
  Session compaction handles folding long conversations.

A turn, end to end:

1. `SessionHarness.stream(input)` resolves the session and appends the input.
2. History is read back — the active view, summary-folded if compaction ran.
3. `contexts` sizes it against the turn model's window and applies cache rules.
4. A fresh `LoopAgent` is built with the model the resolver returns.
5. Each tool call is checked against the authorizer, then executed through the
   effect port. A denial comes back as an ordinary tool result the model can
   read and route around — not a thrown error.
6. Stream parts are mapped to `SessionEvent`s and accumulated into one
   `SessionMessage`, which is persisted when the stream drains.

---

## `@foundry/agents/harness`

The composition layer. Start here.

### `createSessionHarness(settings, context) => Promise<SessionHarness>`

```typescript
type SessionHarnessSettings = AgentHarnessSettings & {
  store?: SessionStore; // default: InMemorySessionStore
  sessionId?: string; // adopt an existing session
  compaction?: CompactionSettings; // auto-fold history when the window fills
  toolContext?: (sessionId: string) => unknown;
  registry?: AgentCompatibilityRegistry;
  mesh?: Mesh;
  nodeId?: string; // default: "primary"
};

type TurnContext = { sessionId: string; model?: string; provider?: string };
```

`SessionHarness` adds two overloads on top of `AgentHarness`:

```typescript
harness.stream(input: SessionInput, opts?: SessionStreamOptions): SessionStream
harness.generate(input: SessionInput, opts?: SessionStreamOptions): Promise<SessionMessage>
```

`SessionInput` is a string or `{ parts }`. The AI SDK's own parameter shape
still works and passes straight through to the underlying agent, unpersisted —
the overload picks by argument shape.

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
  model: { contextWindow: 200_000 }, // omit to size by the turn model's own limits
  keepTokens: 20_000,          // recent history left unfolded
}
```

### `createAgentHarness(settings, context) => Promise<AgentHarness>`

The same thing without a conversation. Use it when the caller owns history.

```typescript
type AgentHarnessSettings = LoopAgentSettings & {
  mcp?: McpManagerOptions & {
    servers?: McpServerConfig[]; // connected by the factory
    manager?: McpManager; // or hand over one you already run
  };
  skills?: Skill[];
  todos?: TodoStore;
  registrations?: HarnessToolRegistration[];
  toolSets?: HarnessToolSet[];
  policy?: AgentAuthorizer; // default: fully permissive
  effectPort?: ToolEffectPort; // default: direct in-process
  agentId?: string;
  agentGeneration?: number;
};
```

Use the factory, not `new` — the constructor never connects MCP, it only reads
what a manager already knows. Tools compose from the built-ins, then `mcp`,
`skills`, `toolSets` in array order, then `registrations`. On a duplicate name
the last one wins.

### Registering a tool

`HarnessToolRegistration` is the sanctioned way in. The compiler preserves your
schema, metadata, and any existing `needsApproval`, and adds capability
derivation, the authorization check, and the effect boundary.

```typescript
import { genericToolSet } from "@foundry/agents/harness";

const set = genericToolSet("deploy", { rollback: rollbackTool });
const harness = await createAgentHarness({ model, toolSets: [set] }, ctx);
```

`genericToolSet(source, tools, meta?)` wraps a plain AI SDK `ToolSet` and tags
its provenance, which is what an audit trail and a per-source policy key on.

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
  | { type: "tool_call"; toolCallId: string; name: string; input: unknown; providerOptions?: … }
  | { type: "tool_result"; toolCallId: string; output: unknown; isError?: boolean }
  | { type: "error"; message: string }
  | { type: "tool_approval_request"; approvalId: string; … }
  | { type: "tool_approval_response"; approvalId: string; approved: boolean; … };

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
  | { type: "tool-call"; toolCallId: string; name: string; input: unknown }
  | {
      type: "tool-result";
      toolCallId: string;
      output: unknown;
      isError?: boolean;
    }
  | ({ type: "tool-approval-request" } & AgentApprovalRequest)
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

## `@foundry/agents/consent`

The gate. This module owns what a capability _is_; the mechanism — the
Authorizer, Grants, Policy tiers — lives in `@foundry/lib/config/authorization` and
knows no agent vocabulary.

```typescript
type Capability =
  | { kind: "web.fetch"; … } | { kind: "mcp.tool"; … }
  | { kind: "module.call"; … } | { kind: "fs.read"; … }
  | DomainCommandCapability | { kind: "tool.call"; … };
```

```typescript
const { authorizer } = createInMemoryAgentAuthorizer({
  policy: { global: "ask", byKind: { "fs.read": "allow" } },
});

const harness = await createAgentHarness({ model, policy: authorizer }, ctx);
```

Two properties worth knowing before you configure it:

- **`tool.call` never inherits the global tier.** It is the unclassified
  fallback, so a blanket `"allow"` must not reach it. Set it explicitly.
- **`decide` runs twice per call, `claim` once.** The check is repeatable and
  consumes nothing, so it can run in the SDK's `needsApproval` predicate _and_
  in the defensive re-check inside `execute`. Authority is spent only by
  `claim`, immediately before the effect, keyed by a stable `invocationId` so a
  replayed continuation re-runs against its own claim.

`explainCapability` is the human framing an approval dialog shows;
`describeCapability` is the flat line an audit log wants. This entry is
renderer-safe — it re-exports only what stays pure, so a UI can import it.

---

## `@foundry/agents/contexts`

Window sizing and provider caching. Siblings, one entry point.

```typescript
const window = new SessionWindow(store, options);
const result = await window.windowFor(sessionId, model); // history, budget and plan

window.recordUsage(sessionId, usage); // record actual usage
window.stateFor(sessionId); // WindowState | undefined

resolveWindow(model); // → the model's context window
resolveBudget(model, options); // → ContextBudget after reserved output
effectiveLimit(budget, 0.8); // → the usable token ceiling
prepareContext(input); // → PrepareOutput: unchanged history and budget diagnostics
estimatingCounter; // a TokenCounter, no tokenizer needed
```

`SessionWindow` is a drop-in `SessionStore` decorator — wrap any store and the
harness keeps working. `prepareContext` currently returns the full history,
flags `overBudget`, and does not trim or summarize. Session compaction is a
separate mechanism in the session harness.

```typescript
cacheDirectivesFor(input); // → CacheDirectives for this provider
resolveCacheProvider(model); // → which cache dialect applies
mergeProviderOptions(a, b); // → the merged providerOptions bag
```

---

## `@foundry/agents/mcp`

Two classes. `McpClient` is one server: it takes a definition, runs the SDK
client for it, and emits `status`, `tools`, and `log`. `McpManager` is the set
of them, keyed by id: it holds the definitions a host persists and the clients
that run for them.

```typescript
const mcp = new McpManager({ spawnStdio }); // seams only, no handlers

const linear = mcp.define({ id: "linear", transport, enabled: true }); // enabled → connects
linear.on("status", render);
mcp.elicit = askTheUser; // default for every client; set `client.elicit` to override

const tools = await mcp.tools(); // enabled ∩ connected, `${id}__name`, capability-tagged
mcp.status(); // → McpServerState[] for a status UI
mcp.definitions(); // → the JSON back out

await mcp.disable("linear"); // closes; `enable` reconnects; `remove` forgets
await mcp[Symbol.asyncDispose]();
```

A definition is plain JSON: `{ id, name?, description?, transport, enabled? }`.
Redefining an id with a transport change reconnects; a metadata change does
not. Each client also exposes `connect`, `close`, `refresh`, `tools()`, and the
resource/prompt helpers, and can be built standalone with `new McpClient(def)`.

Tools carry `source: "mcp"` and an exact `mcp.tool` capability, which is what
lets the _harness_ policy decide a call rather than this package. A failed
client waits out a retry cooldown before the next `connect()` tries again.

`runMcpOAuth` and `UnauthorizedError` are re-exported so a host can drive the
authorization-code exchange without depending on `@ai-sdk/mcp` directly.

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
registry.toolSet; // both, as one HarnessToolSet
registry.add(...skills).remove(name);
```

Pass `toolSet` to a harness and the model gets the catalog and the loaders
together. Bundles stay in memory — the registry holds no paths.

---

## `@foundry/agents/transport`

The wire. One turn, projected as `useChat` chunks.

```typescript
async function* streamSessionAgent(
  agent: SessionHarness,
  input: SessionTurnInput,
  options?: { onFinish?: (e) => void; signal?: AbortSignal },
): AsyncGenerator<UIMessageChunk>;
```

```typescript
sessionTurnShape; // the zod shape for a turn's input
toSessionInput(input); // SessionTurnInput → SessionInput
turnHasInput(input); // is there anything to send?
freshIterable(gen); // wrap before returning across a subscription boundary
projectToUIMessageChunks(stream, options);
```

Pass the subscription's `signal` so a stop button cancels the model request
rather than generating on into a closed stream. Wrap the generator in
`freshIterable` before it crosses the subscription boundary — some transports
throw trying to attach their own `Symbol.asyncDispose`.

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
createLoopAgent(settings)
```

### The model

A harness takes one `AgentModel` at construction. A raw AI SDK model works; a
host registry hands back one that also declares its `route` (the ids recorded
on every message, so a session resumes on the same one) and its `limits` (the
window compaction sizes to). Nothing here resolves ids to models: the host does
that once, and a per-turn change is a new harness with a different model.

`observe` on the settings opens one observation per turn; the harness wraps the
model with it and settles it when the stream drains, not on `onFinish`.
`@foundry/models` ships `observeAgentTurn` in exactly this shape.

```typescript
// ./agents/registry
createAgentRegistry(); // name → agent
createAgentCompatibilityRegistry(); // + preset identity and generation

// ./agents/agent-tool
createAgentTool(config); // any agent, as a callable tool
```

`createAgentTool` resolves subagents by string id at call time, so a parent
never holds a direct reference. With a mesh available it loads the thread's
prior history, streams the subagent's reply, and appends the exchange back.

```typescript
// ./agents/mesh
createMesh(opts)   // → Mesh; peers get spawn_agent / list_agents / ask_agent
HUMAN              // the symbol for the human node

// ./agents/spawn
createSpawnTool(deps)

// ./agents/resolve
createAgentPreset(…)   // → AgentPreset: a configured agent, resolvable per session
```

Peers talk over the ordinary tool loop, and each can spawn sub-peers —
delegation is recursive, and `recursionDepth` is frozen at spawn.

---

## `@foundry/agents/tools/*`

Built-in tools. The harness installs `todo` itself; the rest are opt-in.

```typescript
createTodos(store?)          // the todo tool + a TodoStore that emits events
createQuestions()            // structured questions with typed answers
createWebFetchTools(opts?)   // fetch, capped at WEB_FETCH_MAX_BODY_CHARS
createToolContext(options?)  // the experimental_context tools read
```

`createToolContext` is how a tool reaches the session's conversation store,
space, and policy — `getConversationStore`, `getSpace`, and `getPolicy` read
them back out of an opaque context.

## `@foundry/agents`

The root export is deliberately small: only the memory tool.

```typescript
import { confidenceSchema, Memory, namespaceSchema } from "@foundry/agents";
```

Every other entry point is a subpath. That is on purpose — a renderer importing
`consent` should not drag in an MCP client.

## Local checks

Tests live in `src/test/`; shared helpers live in `src/test/helpers/`.
Run `bun run test`, `bun run typecheck`, and `bun run build` from this package.
Lint and formatting are owned by the repository root.
