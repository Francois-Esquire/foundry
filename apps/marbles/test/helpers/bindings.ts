import type { SessionStore } from "@foundry/agents/store";
import type { Bindings } from "~/lib/definitions/bindings";
import type { Engine, EngineOptions } from "~/lib/engine";
import type { Reply } from "./echo";
import type { TestEngineOptions } from "./engine";
import { testEngine, testInstances } from "./engine";
import { bindLaunch } from "./launch";

export interface MockBindingOptions
  extends Pick<
    TestEngineOptions,
    "executors" | "hold" | "live" | "root" | "sessions" | "state"
  > {
  readonly log?: (line: string) => void;
}

export interface MockBindings {
  readonly bindings: Bindings;
  dispose(): Promise<void>;
  readonly engine: Engine;
  readonly instances: Pick<
    EngineOptions,
    "git" | "models" | "sessions" | "workspaces"
  >;
  readonly sessions: SessionStore;
  readonly warnings: string[];
}

const AGENTS = "[agents] ";

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
