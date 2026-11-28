import type { Models } from "@foundry/models";
import type { TaskStore } from "@foundry/tasks";
import type { Output } from "ai";
import type { Catalog } from "~/authoring/catalog";
import type { AgentLike } from "~/lib/definitions/types";
import type { Engine } from "~/lib/engine";
import type { ExecutionContext } from "~/lib/runs/context";
import type { Current } from "~/lib/runs/scope";
import {
  currentExecutionContext,
  currentRun,
  currentSetupCounters,
  scopeStorageFor,
} from "~/lib/runs/scope-bridge";

export type InstanceRuntime = Pick<
  Engine,
  | "agents"
  | "artifacts"
  | "bindings"
  | "context"
  | "definition"
  | "dispose"
  | "disposed"
  | "execute"
  | "enqueueDefinition"
  | "models"
  | "readRun"
  | "readRuns"
  | "sandboxes"
  | "taskStore"
  | "workspaceId"
  | "workspaces"
>;

interface Binding {
  catalog: Catalog | undefined;
  released: boolean;
  runtime: InstanceRuntime | undefined;
  readonly workspaceId: string;
}

interface Hosting {
  readonly binding: Binding;
  readonly catalog: Catalog | undefined;
  readonly id: string;
}

export interface LoadScope {
  readonly workspaceId: string;
}

interface LoadingRoute extends LoadScope {
  readonly created: Set<object>;
  readonly definitions: Map<string, number>;
  finished: boolean;
  readonly kind: "loading";
  readonly locked: Set<object>;
}

type Route =
  | { readonly binding: Binding; readonly kind: "binding" }
  | { readonly kind: "workspace"; readonly workspaceId: string }
  | { readonly kind: "unbound-context"; readonly workspaceId: string }
  | LoadingRoute;

interface RuntimeState {
  bound: Set<Binding>;
  bunEvaluatingLoads: Set<LoadingRoute>;
  contextBindings: WeakMap<ExecutionContext, Binding>;
  createFallback: (() => Promise<InstanceRuntime>) | undefined;
  fallback: Promise<InstanceRuntime> | undefined;
  fallbackRoot: () => string;
  hostings: Map<string, Hosting>;
  hostState: "unhosted" | "loading" | "hosted";
  pendingHostings: Set<string>;
  released: Set<string>;
  unnamedRefused: boolean;
}

const RUNTIME_STATE_KEY = Symbol.for("marbles.runtime.state.v1");
const ROUTE_STORAGE_KEY = Symbol.for("marbles.runtime.route.v1");

function runtimeState(): RuntimeState {
  const holder = globalThis as Record<symbol, RuntimeState | undefined>;
  let state = holder[RUNTIME_STATE_KEY];
  if (state === undefined) {
    state = {
      bound: new Set<Binding>(),
      bunEvaluatingLoads: new Set<LoadingRoute>(),
      contextBindings: new WeakMap<ExecutionContext, Binding>(),
      createFallback: undefined,
      fallback: undefined,
      fallbackRoot: () => "/",
      hostings: new Map<string, Hosting>(),
      hostState: "unhosted",
      pendingHostings: new Set<string>(),
      released: new Set<string>(),
      unnamedRefused: false,
    };
    holder[RUNTIME_STATE_KEY] = state;
  }
  return state;
}

function routeScope() {
  return scopeStorageFor<Route>(ROUTE_STORAGE_KEY);
}

function activeBunLoads(): LoadingRoute[] {
  const active: LoadingRoute[] = [];
  for (const route of runtimeState().bunEvaluatingLoads) {
    if (!route.finished) {
      active.push(route);
    }
  }
  return active;
}

function activeLoadingRoute(): LoadingRoute | undefined {
  const scoped = routeScope().getStore();
  if (scoped?.kind === "loading") {
    return scoped.finished ? undefined : scoped;
  }
  if (scoped !== undefined || currentExecutionContext() !== undefined) {
    return undefined;
  }
  const bunLoads = activeBunLoads();
  return bunLoads.length === 1 ? bunLoads[0] : undefined;
}

function anyActiveLoadingRoute(): LoadingRoute | undefined {
  const scoped = routeScope().getStore();
  if (scoped?.kind === "loading") {
    return scoped.finished ? undefined : scoped;
  }
  if (scoped !== undefined || currentExecutionContext() !== undefined) {
    return undefined;
  }
  return activeBunLoads()[0];
}

export async function withBunEvaluatingLoad<T>(
  work: () => Promise<T>
): Promise<T> {
  const scoped = routeScope().getStore();
  const route =
    scoped?.kind === "loading" && !scoped.finished ? scoped : undefined;
  if (route === undefined) {
    return await work();
  }
  const loads = runtimeState().bunEvaluatingLoads;
  loads.add(route);
  try {
    return await work();
  } finally {
    loads.delete(route);
  }
}

export function expectHost(): void {
  const state = runtimeState();
  if (state.hostState === "unhosted") {
    state.hostState = "loading";
  }
}

function isReleased(binding: Binding): boolean {
  const state = runtimeState();
  if (!binding.released && binding.runtime?.disposed !== false) {
    binding.released = true;
    binding.runtime = undefined;
    binding.catalog = undefined;
    state.bound.delete(binding);
  }
  return binding.released;
}

function liveBindings(workspaceId: string): Binding[] {
  const state = runtimeState();
  return [...state.bound].filter(
    (binding) => binding.workspaceId === workspaceId && !isReleased(binding)
  );
}

function sweep(): void {
  const state = runtimeState();
  for (const binding of [...state.bound]) {
    isReleased(binding);
  }
  for (const id of [...state.hostings.keys()]) {
    liveHosting(id);
  }
}

class AmbiguousWorkspaceError extends Error {
  override readonly name = "AmbiguousWorkspaceError";
}

class WorkspaceReleasedError extends Error {
  override readonly name = "WorkspaceReleasedError";
}

class WorkspaceLoadingError extends Error {
  override readonly name = "WorkspaceLoadingError";
}

function loadingError(
  word: string,
  workspaceId: string
): WorkspaceLoadingError {
  return new WorkspaceLoadingError(
    `workspace ${workspaceId}: ${word} is not available while its source loads`
  );
}

function missingRuntimeError(): Error {
  return new Error(
    'no Marbles host or default runtime is configured; run via `marbles`, or import "@foundry.sh/marbles/engine" to enable the default Node runtime'
  );
}

export interface LoadScopeResult<T> {
  readonly created: ReadonlySet<object>;
  readonly locked: ReadonlySet<object>;
  readonly value: T;
}

export async function runLoadScope<T>(
  scope: LoadScope,
  work: () => Promise<T>
): Promise<LoadScopeResult<T>> {
  const state = runtimeState();
  const route: LoadingRoute = {
    created: new Set<object>(),
    definitions: new Map<string, number>(),
    finished: false,
    kind: "loading",
    locked: new Set<object>(),
    workspaceId: scope.workspaceId,
  };
  if (liveHosting(scope.workspaceId) === undefined) {
    state.pendingHostings.add(scope.workspaceId);
  }
  try {
    const value = await routeScope().run(route, work);
    return {
      created: new Set(route.created),
      locked: new Set(route.locked),
      value,
    };
  } catch (error) {
    state.pendingHostings.delete(scope.workspaceId);
    throw error;
  } finally {
    route.finished = true;
    route.created.clear();
    route.locked.clear();
    route.definitions.clear();
  }
}

export async function withLoadScope<T>(
  scope: LoadScope,
  work: () => Promise<T>
): Promise<T> {
  const { value } = await runLoadScope(scope, work);
  return value;
}

export function trackCreatedDeclaration(declaration: object): void {
  activeLoadingRoute()?.created.add(declaration);
}

export function trackLockedDeclaration(declaration: object): void {
  activeLoadingRoute()?.locked.add(declaration);
}

export function claimLoadDefinition(hash: string): string | undefined {
  const route = activeLoadingRoute();
  if (route === undefined) {
    return undefined;
  }
  const occurrence = route.definitions.get("definition") ?? 0;
  route.definitions.set("definition", occurrence + 1);
  return `load:definition#${String(occurrence)}:${hash}`;
}

export type Scope = <T>(work: () => T) => T;

export function captureScope(): Scope {
  const state = runtimeState();
  const context = currentExecutionContext();
  let captured: Exclude<Route, LoadingRoute> | undefined;
  if (context === undefined) {
    const currentRoute = routeScope().getStore();
    if (currentRoute?.kind === "loading") {
      captured = { kind: "workspace", workspaceId: currentRoute.workspaceId };
    } else if (currentRoute !== undefined) {
      captured = currentRoute;
    }
  } else {
    const binding = state.contextBindings.get(context);
    captured =
      binding === undefined
        ? { kind: "unbound-context", workspaceId: context.workspaceId }
        : { binding, kind: "binding" };
  }
  if (captured === undefined) {
    return (work) => work();
  }
  const kept = captured;
  return (work) => {
    if (anyActiveLoadingRoute() !== undefined) {
      return work();
    }
    return routeScope().run(kept, work);
  };
}

export function refuseUnnamedWork(): void {
  runtimeState().unnamedRefused = true;
}

export function setHost(runtime: InstanceRuntime, declared?: Catalog): void {
  const state = runtimeState();
  sweep();
  const binding: Binding = {
    catalog: declared,
    released: false,
    runtime,
    workspaceId: runtime.workspaceId,
  };
  state.bound.add(binding);
  state.contextBindings.set(runtime.context, binding);
  state.hostings.set(runtime.workspaceId, {
    binding,
    catalog: declared,
    id: runtime.workspaceId,
  });
  state.pendingHostings.delete(runtime.workspaceId);
  state.released.delete(runtime.workspaceId);
  state.hostState = "hosted";
}

export function releaseEngine(runtime: InstanceRuntime): void {
  if (!runtime.disposed) {
    return;
  }
  sweep();
}

function owner(): Route | undefined {
  const state = runtimeState();
  const context = currentExecutionContext();
  if (context !== undefined) {
    const binding = state.contextBindings.get(context);
    return binding === undefined
      ? { kind: "unbound-context", workspaceId: context.workspaceId }
      : { binding, kind: "binding" };
  }
  const scoped = routeScope().getStore();
  if (scoped?.kind === "loading" && scoped.finished) {
    return { kind: "workspace", workspaceId: scoped.workspaceId };
  }
  return scoped;
}

function live(binding: Binding): {
  readonly catalog: Catalog | undefined;
  readonly runtime: InstanceRuntime;
} {
  const { catalog: taken, runtime } = binding;
  if (isReleased(binding) || runtime === undefined) {
    throw releasedError(binding.workspaceId);
  }
  return { catalog: taken, runtime };
}

function soleHosting(workspaceId: string): Hosting | undefined {
  const alive = liveBindings(workspaceId);
  if (alive.length > 1) {
    throw new AmbiguousWorkspaceError(
      `this call names workspace ${workspaceId} and no engine of it, and ${String(alive.length)} of its engines are running here (one still finishing its runs beside the one that replaced it), so none of them answers it`
    );
  }
  return liveHosting(workspaceId);
}

interface Answer {
  readonly catalog: Catalog | undefined;
  readonly id: string;
  readonly runtime: InstanceRuntime;
}

function liveHosting(id: string): Hosting | undefined {
  const state = runtimeState();
  const hosting = state.hostings.get(id);
  if (hosting !== undefined && isReleased(hosting.binding)) {
    state.hostings.delete(id);
    state.released.add(id);
    return;
  }
  return hosting;
}

function answerOf(hosting: Hosting): Answer | undefined {
  const { runtime } = hosting.binding;
  if (runtime === undefined) {
    return;
  }
  return {
    catalog: hosting.catalog,
    id: hosting.id,
    runtime,
  };
}

function refuseUnbound(workspaceId: string): void {
  const state = runtimeState();
  if (liveBindings(workspaceId).length > 0) {
    throw new AmbiguousWorkspaceError(
      `this call comes from a run of an engine of workspace ${workspaceId} that no host here bound, and another engine is bound to that workspace here, so neither answers it`
    );
  }
  if (state.released.has(workspaceId)) {
    throw releasedError(workspaceId);
  }
}

function releasedError(id?: string): WorkspaceReleasedError {
  const named =
    id === undefined ? "the workspace this work belongs to" : `workspace ${id}`;
  return new WorkspaceReleasedError(
    `${named} is no longer hosted in this process: its host closed, so nothing it started outlives it here; nothing was read, written or declared`
  );
}

function unnamedError(): AmbiguousWorkspaceError {
  return new AmbiguousWorkspaceError(
    "this call names no workspace: it comes from outside every workspace's runs, observers and modules (a package, or Marbles itself), and this process hosts several, so none of them answers it"
  );
}

function answerWorkspace(
  workspaceId: string,
  word: string | undefined
): Answer | undefined {
  const state = runtimeState();
  const sole = soleHosting(workspaceId);
  if (sole !== undefined) {
    return answerOf(sole);
  }
  if (state.released.has(workspaceId)) {
    throw releasedError(workspaceId);
  }
  if (state.pendingHostings.has(workspaceId) && word !== undefined) {
    throw loadingError(word, workspaceId);
  }
  return undefined;
}

function answering(word?: string): Answer | undefined {
  const state = runtimeState();
  const own = owner();
  if (own?.kind === "binding") {
    const { catalog: taken, runtime } = live(own.binding);
    return { catalog: taken, id: runtime.workspaceId, runtime };
  }
  if (own?.kind === "unbound-context") {
    refuseUnbound(own.workspaceId);
    return undefined;
  }
  if (own?.kind === "loading") {
    if (word !== undefined) {
      throw loadingError(word, own.workspaceId);
    }
    return undefined;
  }
  if (own?.kind === "workspace") {
    return answerWorkspace(own.workspaceId, word);
  }
  const loading = anyActiveLoadingRoute();
  if (loading !== undefined) {
    if (word !== undefined) {
      throw loadingError(word, loading.workspaceId);
    }
    return undefined;
  }
  if (state.unnamedRefused) {
    throw unnamedError();
  }
  const hosted = [...state.hostings.keys()].flatMap((id) => {
    const each = liveHosting(id);
    return each === undefined ? [] : [each];
  });
  if (hosted.length > 1) {
    throw new AmbiguousWorkspaceError(
      `this process hosts ${String(hosted.length)} workspaces (${hosted.map((each) => each.id).join(", ")}), and this call names none of them: it runs outside their runs, observers and modules, so none of them answers it`
    );
  }
  const [only] = hosted;
  if (only === undefined) {
    return;
  }
  const sole = soleHosting(only.id);
  return sole === undefined ? undefined : answerOf(sole);
}

function activeHost(): InstanceRuntime | undefined {
  return answering()?.runtime;
}

export function activeAgentId(
  agent: AgentLike<Output.Output>
): string | undefined {
  const state = runtimeState();
  const context = currentExecutionContext();
  if (context !== undefined) {
    const fromContext = context.agentIdOf?.(agent);
    if (fromContext !== undefined) {
      return fromContext;
    }
    const binding = state.contextBindings.get(context);
    if (binding !== undefined && !isReleased(binding)) {
      return binding.catalog?.agentIdOf(agent);
    }
    return undefined;
  }
  if (anyActiveLoadingRoute() !== undefined) {
    return undefined;
  }
  try {
    return answering()?.catalog?.agentIdOf(agent);
  } catch {
    return undefined;
  }
}

export function hostModels(): Models | undefined {
  const state = runtimeState();
  const context = currentExecutionContext();
  if (context !== undefined && !state.contextBindings.has(context)) {
    return context.models;
  }
  return activeHost()?.models;
}

export function hostTaskStore(): TaskStore | undefined {
  const state = runtimeState();
  const hosting = answering("tasks");
  if (hosting === undefined && state.hostState === "unhosted") {
    return;
  }
  if (hosting !== undefined) {
    return hosting.runtime.taskStore;
  }
  if (state.hostState === "loading") {
    throw new WorkspaceLoadingError(
      "tasks: the workspace's tasks are not available while its source loads; use them in a step, an observe handler, or once the host has started"
    );
  }
  throw new Error(
    "tasks: the workspace host that held these tasks was disposed; nothing was read or written"
  );
}

export function ownRun(): Current | undefined {
  return currentRun();
}

export function activeSetupCounters(): Map<string, number> | undefined {
  return currentSetupCounters();
}

function hostless(
  word: string,
  verb: "enqueue" | "read",
  loading: boolean
): Error {
  return loading
    ? new WorkspaceLoadingError(
        `${word}: the workspace's runs are not available while its source loads; ${verb} them in a step, an observe handler, or once the host has started`
      )
    : new Error(
        `${word}: the workspace host that held these runs was disposed; nothing was ${verb === "enqueue" ? "enqueued" : "read"}`
      );
}

export function readingRuntime(word: string): Promise<InstanceRuntime | null> {
  const state = runtimeState();
  let hosting: Answer | undefined;
  try {
    hosting = answering(word);
  } catch (error) {
    return Promise.reject(error);
  }
  if (hosting !== undefined) {
    return Promise.resolve(hosting.runtime);
  }
  if (state.hostState === "unhosted") {
    return state.fallback ?? Promise.resolve(null);
  }
  return Promise.reject(hostless(word, "read", state.hostState === "loading"));
}

export interface Enqueuing {
  readonly runtime: InstanceRuntime;
}

export function enqueuingRuntime(word: string): Promise<Enqueuing> {
  const state = runtimeState();
  let hosting: Answer | undefined;
  try {
    hosting = answering(word);
  } catch (error) {
    return Promise.reject(error);
  }
  if (hosting !== undefined) {
    return Promise.resolve({ runtime: hosting.runtime });
  }
  if (state.hostState === "unhosted") {
    return instanceRuntime().then((runtime) => ({ runtime }));
  }
  return Promise.reject(
    hostless(word, "enqueue", state.hostState === "loading")
  );
}

export function hasDefaultRuntime(): boolean {
  return runtimeState().createFallback !== undefined;
}

export function setDefaultRuntime(
  create: () => Promise<InstanceRuntime>
): void {
  runtimeState().createFallback = create;
}

export function setDefaultRoot(get: () => string): void {
  runtimeState().fallbackRoot = get;
}

export function instanceRoot(): string {
  return activeHost()?.bindings.root ?? runtimeState().fallbackRoot();
}

export function instanceRuntime(): Promise<InstanceRuntime> {
  const state = runtimeState();
  let answer: Answer | undefined;
  try {
    answer = answering("runtime");
  } catch (error) {
    return Promise.reject(error);
  }
  if (answer !== undefined) {
    return Promise.resolve(answer.runtime);
  }
  const create = state.createFallback;
  if (create === undefined) {
    return Promise.reject(missingRuntimeError());
  }
  state.fallback ??= create();
  return state.fallback;
}

export async function dispose(): Promise<void> {
  const state = runtimeState();
  const pending = state.fallback;
  state.fallback = undefined;
  await (await pending)?.dispose();
}
