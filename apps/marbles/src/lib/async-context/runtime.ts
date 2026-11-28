export type ContextKey = string | symbol;

export interface ContextVariable<T> {
  exit<R>(work: () => R): R;
  get(): T | undefined;
  run<R>(value: T, work: () => R): R;
}

export type ContextSnapshot = <R>(work: () => R) => R;

export interface ContextRuntime {
  snapshot(): ContextSnapshot;
  variable<T>(key: ContextKey): ContextVariable<T>;
}

const IDENTITY_SNAPSHOT: ContextSnapshot = (work) => work();

function createSyncVariable<T>(): ContextVariable<T> {
  const stack: (T | undefined)[] = [];
  const run = <R>(value: T | undefined, work: () => R): R => {
    stack.push(value);
    try {
      return work();
    } finally {
      stack.pop();
    }
  };
  return {
    exit: (work) => run(undefined, work),
    get: () => stack.at(-1),
    run: (value, work) => run(value, work),
  };
}

export function createPortableContextRuntime(): ContextRuntime {
  const variables = new Map<ContextKey, ContextVariable<unknown>>();
  return {
    snapshot: () => IDENTITY_SNAPSHOT,
    variable<T>(key: ContextKey): ContextVariable<T> {
      let variable = variables.get(key) as ContextVariable<T> | undefined;
      if (variable === undefined) {
        variable = createSyncVariable<T>();
        variables.set(key, variable as ContextVariable<unknown>);
      }
      return variable;
    },
  };
}

interface SharedRuntimeState {
  runtime: ContextRuntime | undefined;
  readonly variables: Map<ContextKey, ContextVariable<unknown>>;
}

const SHARED_RUNTIME_KEY = Symbol.for("marbles.context-runtime.v1");

function sharedState(): SharedRuntimeState {
  const holder = globalThis as Record<symbol, SharedRuntimeState | undefined>;
  let state = holder[SHARED_RUNTIME_KEY];
  if (state === undefined) {
    state = {
      runtime: undefined,
      variables: new Map<ContextKey, ContextVariable<unknown>>(),
    };
    holder[SHARED_RUNTIME_KEY] = state;
  }
  return state;
}

function backingVariable<T>(
  state: SharedRuntimeState,
  key: ContextKey
): ContextVariable<T> {
  let variable = state.variables.get(key) as ContextVariable<T> | undefined;
  if (variable === undefined) {
    variable =
      state.runtime === undefined
        ? createSyncVariable<T>()
        : state.runtime.variable<T>(key);
    state.variables.set(key, variable as ContextVariable<unknown>);
  }
  return variable;
}

export function installContextRuntime(runtime: ContextRuntime): void {
  const state = sharedState();
  if (state.runtime !== undefined) {
    return;
  }
  state.runtime = runtime;
  for (const key of state.variables.keys()) {
    state.variables.set(key, runtime.variable(key));
  }
}

export function sharedContextRuntime(): ContextRuntime {
  return {
    snapshot(): ContextSnapshot {
      const { runtime } = sharedState();
      return runtime === undefined ? IDENTITY_SNAPSHOT : runtime.snapshot();
    },
    variable<T>(key: ContextKey): ContextVariable<T> {
      return {
        exit: (work) => backingVariable<T>(sharedState(), key).exit(work),
        get: () => backingVariable<T>(sharedState(), key).get(),
        run: (value, work) =>
          backingVariable<T>(sharedState(), key).run(value, work),
      };
    },
  };
}
