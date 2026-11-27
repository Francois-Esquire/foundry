import { homedir } from "node:os";
import type { SessionStore } from "@foundry/agents/store";
import { MemorySessionStore } from "@foundry/agents/store/memory";
import { Authorization } from "@foundry/authorization";
import { MemoryAuthorizationStore } from "@foundry/authorization/store/memory";
import type { Models } from "@foundry/models";
import type { Output } from "ai";
import type { AutomationService } from "~/lib/automation/service";
import type { AutomationStore } from "~/lib/automation/store";
import { MemoryAutomationStore } from "~/lib/automation/store";
import type { Bindings, HostBindings } from "~/lib/bindings";
import { commandRunner } from "~/lib/command";
import type { EngineOptions } from "~/lib/engine";
import { environmentSnapshot } from "~/lib/environment";
import type { ExecutionContext } from "~/lib/execution-context";
import type { ExecutionStore } from "~/lib/execution-store";
import { MemoryExecutionStore } from "~/lib/execution-store";
import type { Executions } from "~/lib/executions";
import { selectExecutor } from "~/lib/executor";
import type { FeedPublisher } from "~/lib/feed/publish";
import { createLog } from "~/lib/log";
import { AgentsManager } from "~/lib/managers/agents";
import type { ArtifactsManager } from "~/lib/managers/artifacts";
import type { RunsSource } from "~/lib/managers/runs";
import { engineRuns, scopedRuns } from "~/lib/managers/runs";
import type { SandboxesManager } from "~/lib/managers/sandboxes";
import { skillResolver } from "~/lib/managers/skills";
import type { WorkspacesManager } from "~/lib/managers/workspaces";
import type { ReadonlyRunScopes, RecordedScope } from "~/lib/run-scope";
import { workingDirectory } from "~/lib/run-scope";
import type { RunStore } from "~/lib/run-store";
import { MemoryRunStore } from "~/lib/run-store";
import type { HarnessActivities } from "~/lib/sandbox/activities";
import { HarnessInteractions } from "~/lib/sandbox/interactions";
import type { TriggerStore } from "~/lib/trigger-store";
import { MemoryTriggerStore } from "~/lib/trigger-store";
import type { AgentLike } from "~/lib/types";
import type { UsageLedger } from "~/lib/usage";
import type { RunRecorded, SessionListing } from "~/lib/usage-evidence";
import { listsSessions } from "~/lib/usage-evidence";
import type { UsageStore } from "~/lib/usage-store";
import { MemoryUsageStore } from "~/lib/usage-store";

export function contextOf(
  options: EngineOptions,
  spawned: string | undefined,
  currentModels: () => Models | undefined,
  agentIdOf?: (agent: AgentLike<Output.Output>) => string | undefined
): ExecutionContext {
  return {
    ...(agentIdOf === undefined ? {} : { agentIdOf }),
    cwd: options.cwd ?? options.root,
    environment: options.environment ?? environmentSnapshot(),
    get models() {
      return currentModels();
    },
    ...(spawned === undefined ? {} : { spawned }),
    workspaceId: options.workspaceId,
  };
}

export function sessionListing(
  sessions: SessionStore,
  usage: UsageStore
): { readonly stamps?: SessionListing } {
  if (listsSessions(sessions)) {
    return { stamps: () => sessions.stamps() };
  }
  const outlives = !(
    sessions instanceof MemorySessionStore || usage instanceof MemoryUsageStore
  );
  return outlives ? { stamps: "unavailable" } : {};
}

export function storesOf(options: EngineOptions): {
  readonly automations: AutomationStore;
  readonly executions: ExecutionStore;
  readonly runs: RunStore;
  readonly triggers: TriggerStore;
  readonly usage: UsageStore;
} {
  return {
    automations: options.automationStore ?? new MemoryAutomationStore(),
    executions: options.executionStore ?? new MemoryExecutionStore(),
    runs: options.runs ?? new MemoryRunStore(),
    triggers: options.triggers ?? new MemoryTriggerStore(),
    usage: options.usageStore ?? new MemoryUsageStore(),
  };
}

export function recordedIn(
  scopes: ReadonlyRunScopes,
  runs: RunStore
): (runId: string) => Promise<RunRecorded> {
  return async (runId) => {
    const scope = scopes.get(runId);
    if (scope) {
      return { ledger: scope.ledger.toJSON(), session: scope.session.id };
    }
    try {
      return await runs.recorded(runId);
    } catch {
      return "unreadable";
    }
  };
}

export function storedScopes(
  runs: RunStore
): (runId: string) => Promise<RecordedScope | undefined> {
  return async (runId) => {
    const stored = await runs.recorded(runId);
    if (stored.session === undefined) {
      return;
    }
    return {
      ledger: stored.ledger,
      ...(stored.literals === undefined ? {} : { literals: stored.literals }),
      session: { id: stored.session },
    };
  };
}

export function authorizationOf(options: EngineOptions): Authorization {
  return (
    options.authorization ??
    new Authorization({
      store: options.authorizationStore ?? new MemoryAuthorizationStore(),
    })
  );
}

export function interactionsOf(
  options: EngineOptions,
  feed: FeedPublisher,
  authorization: Authorization
): HarnessInteractions {
  return new HarnessInteractions({
    askable: options.askable ?? false,
    authorization,
    feed,
    sessions: options.sessions,
  });
}

export function agentsOf(
  options: EngineOptions,
  parts: {
    readonly activities: HarnessActivities;
    readonly agentIdOf?: (
      agent: AgentLike<Output.Output>
    ) => string | undefined;
    readonly authorization: Authorization;
    readonly automations: AutomationService;
    readonly context: ExecutionContext;
    readonly executions: Executions;
    readonly interactions: HarnessInteractions;
    readonly sandboxes: SandboxesManager;
    readonly usage: UsageLedger;
  }
): AgentsManager {
  const { models, providers, root, sessions, workspaceId } = options;
  const print = options.print ?? (() => undefined);
  return new AgentsManager({
    activities: parts.activities,
    ...(parts.agentIdOf === undefined ? {} : { agentIdOf: parts.agentIdOf }),
    authorization: parts.authorization,
    automations: parts.automations,
    containerOf: (sandbox) => parts.sandboxes.containerOf(sandbox),
    context: parts.context,
    ...(options.createMcpClient === undefined
      ? {}
      : { createMcpClient: options.createMcpClient }),
    defaultExecutor: () => selectExecutor(models),
    dry: options.dry ?? false,
    executionOf: (provider) => providers?.executionOf(provider),
    ...(providers
      ? {
          instanceOf: (provider: string) => providers.identityOf(provider),
        }
      : {}),
    cwd: parts.context.cwd,
    implementationOf: (provider) =>
      providers
        ?.list()
        .find((entry) => entry.id === provider && entry.position !== undefined)
        ?.plugin,
    interactions: parts.interactions,
    models,
    observe: (runId, observation) =>
      parts.executions.observe(runId, observation),
    requireProviders: () => providers?.require(),
    sessions,
    skills:
      options.skills ??
      skillResolver({ home: options.home ?? homedir(), workspace: root }),
    undefinedProvider: (id) => providers?.undefinedProvider(id),
    usage: { ledger: parts.usage, workspaceId },
    warn: (message) => print(`[agents] ${message}`),
  });
}

export function bindingsOf(
  options: EngineOptions,
  parts: {
    readonly agents: AgentsManager;
    readonly artifacts: ArtifactsManager;
    readonly catalogue: NonNullable<HostBindings["catalogue"]>;
    readonly context: ExecutionContext;
    readonly print: (line: string) => void;
    readonly runs: RunsSource;
    readonly sandboxes: SandboxesManager;
    readonly triggers: TriggerStore;
    readonly workspaces: WorkspacesManager;
  }
): Bindings {
  const { context, print } = parts;
  return {
    agents: (args) => parts.agents.scoped(args),
    artifacts: (args) => parts.artifacts.scoped(args),
    context,
    exec: ({ frame, scope, write }) =>
      (options.commandRunner ?? commandRunner)({
        cwd: () => workingDirectory(scope.cwd),
        dry: options.dry ?? false,
        environment: context.environment,
        print,
        ...(context.spawned === undefined ? {} : { spawned: context.spawned }),
        signal: () => frame.signal,
        work: frame.work,
        write,
      }),
    host: { catalogue: parts.catalogue, triggers: parts.triggers },
    log: createLog((level, message) =>
      options.log
        ? options.log(level, message, { kind: "step" })
        : print(message)
    ),
    root: options.root,
    runs: (args) =>
      args === undefined
        ? engineRuns(parts.runs)
        : scopedRuns(parts.runs, args),
    sandboxes: (args) => parts.sandboxes.scoped(args),
    setupLog: (run) =>
      createLog((level, message) =>
        options.log
          ? options.log(level, message, {
              kind: "setup",
              runId: run.id,
              workflow: run.workflow,
            })
          : print(message)
      ),
    turns: (args) => parts.agents.turns(args),
    workspaces: (args) => parts.workspaces.scoped(args),
  };
}
