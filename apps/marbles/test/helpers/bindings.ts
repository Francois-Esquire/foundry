import type { SessionStore } from "@foundry/agents/session";
import type { Bindings } from "~/lib/bindings";
import type { Engine, EngineOptions } from "~/lib/engine";
import type { Reply } from "~/lib/models/echo";
import type { TestEngineOptions } from "./engine";
import { testEngine, testInstances } from "./engine";
import { bindLaunch } from "./launch";

export interface MockBindingOptions
  extends Pick<
    TestEngineOptions,
    "executors" | "hold" | "live" | "root" | "sessions" | "state"
  > {
  /** Every line a body logs. */
  readonly log?: (line: string) => void;
}

export interface MockBindings {
  readonly bindings: Bindings;
  dispose(): Promise<void>;
  /** The engine the bindings belong to; never started. */
  readonly engine: Engine;
  /** Spread into `startEngine({ ... })` for an engine over the same models, sessions and workspaces. */
  readonly instances: Pick<
    EngineOptions,
    "git" | "models" | "sessions" | "workspaces"
  >;
  readonly sessions: SessionStore;
  /** What the agents manager warned about. */
  readonly warnings: string[];
}

const AGENTS = "[agents] ";

/**
 * A test engine over mock models with a scripted reply. `launch` runs
 * against its bindings at once; an engine a test starts itself takes
 * `instances`. Call `dispose` when the test is done.
 */
export function bindMock(
  reply: Reply,
  options: MockBindingOptions = {}
): MockBindings {
  const { log, ...rest } = options;
  const warnings: string[] = [];
  const { git, models, sessions, workspaces } = testInstances({
    ...rest,
    reply,
  });
  const engine = testEngine({
    ...rest,
    git,
    models,
    print: (line) => {
      if (line.startsWith(AGENTS)) {
        warnings.push(line.slice(AGENTS.length));
      } else {
        log?.(line);
      }
    },
    sessions,
    workspaces,
  });
  bindLaunch(engine.bindings);
  return {
    bindings: engine.bindings,
    dispose: () => engine.dispose(),
    engine,
    instances: { git, models, sessions, workspaces },
    sessions,
    warnings,
  };
}
