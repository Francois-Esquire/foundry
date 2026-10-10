import type { TurnOptions } from "@foundry/agents/harness";
import type { SessionInput, SessionStream } from "@foundry/agents/session";
import { isSuspendSignal } from "@foundry/workflows/executable";
import { Workflow } from "@foundry/workflows/workflow";
import type { Output } from "ai";

import type { Bindings, ManagerArgs } from "./bindings";
import type { AnyDefinition } from "./definition";
import { deferredStream } from "./managers/agent-turns";
import type { AgentTurns } from "./managers/agents";
import { current, RunScopes } from "./run-scope";
import { instanceRuntime } from "./runtime";
import { factoryFor } from "./tree";
import type { Agent, AgentDefinition, SessionReply } from "./types";

/**
 * What a definition does when it is called rather than locked. Inside a
 * step body the call joins the body's run: it is cancelled with the step,
 * writes to its stream, and is replayed from the ledger. Anywhere else it
 * runs on the host's engine, or a default runtime in a plain script.
 */

/** The step a body runs in, as its managers take it. */
function inRun(): { bindings: Bindings; args: ManagerArgs } | undefined {
  const store = current.getStore();
  return (
    store && {
      args: { frame: store.frame, scope: store.scope, write: store.write },
      bindings: store.bindings,
    }
  );
}

function turnsOf(bindings: Bindings, args?: ManagerArgs): AgentTurns {
  if (!bindings.turns) {
    throw new Error(
      "this engine cannot run an agent's own turns; use agents.session"
    );
  }
  return bindings.turns(args);
}

/**
 * Give an agent definition `generate` and `stream`: one turn on a fresh
 * session each. They are not enumerable, so a spread of the agent is a
 * plain definition.
 */
export function agentInstance<OUTPUT extends Output.Output>(
  definition: AgentDefinition<OUTPUT>
): Agent<OUTPUT> {
  const self = definition as AgentDefinition<Output.Output>;
  const generate = <CALL extends Output.Output = OUTPUT>(
    input: SessionInput,
    options?: TurnOptions<CALL>
  ): Promise<SessionReply<CALL>> => {
    const run = inRun();
    if (run) {
      return turnsOf(run.bindings, run.args).generate(self, input, options);
    }
    return instanceRuntime().then((runtime) =>
      turnsOf(runtime.bindings).generate(self, input, options)
    );
  };
  const stream = <CALL extends Output.Output = OUTPUT>(
    input: SessionInput,
    options?: TurnOptions<CALL>
  ): SessionStream<CALL> => {
    const run = inRun();
    if (run) {
      return turnsOf(run.bindings, run.args).stream(self, input, options);
    }
    return deferredStream(
      instanceRuntime().then((runtime) =>
        turnsOf(runtime.bindings).stream(self, input, options)
      )
    );
  };
  return Object.defineProperties(definition, {
    generate: { value: generate },
    stream: { value: stream },
  }) as Agent<OUTPUT>;
}

const RUN_KIND = "step.run";
/** The root key of a nameless definition run directly. */
const NAMELESS = "run";

/**
 * Run a step or workflow in this process and return its output. Inside a
 * body the call is recorded, and a replay returns the recorded output
 * without running it again; the nested run is cancelled with the calling
 * step. A host does not see the nested run, so it cannot steer or pause it.
 */
export function runDefinition(
  definition: AnyDefinition,
  input: unknown
): Promise<unknown> {
  const run = inRun();
  if (!run) {
    return instanceRuntime().then(({ bindings }) =>
      runHere(definition, input, bindings)
    );
  }
  const { frame, scope } = run.args;
  // Claimed before anything is awaited, so call order decides the key.
  const { key } = scope.claim(frame, RUN_KIND);
  if (scope.ledger.has(key)) {
    return Promise.resolve(scope.ledger.get<{ output?: unknown }>(key)?.output);
  }
  return runHere(definition, input, run.bindings, frame.signal).then(
    (output) => {
      scope.ledger.set(key, { output });
      return output;
    }
  );
}

async function runHere(
  definition: AnyDefinition,
  input: unknown,
  bindings: Bindings,
  signal?: AbortSignal
): Promise<unknown> {
  signal?.throwIfAborted();
  const scopes = new RunScopes();
  const name = definition.name ?? NAMELESS;
  const stop = () => {
    for (const scope of scopes) {
      scope.abort(signal?.reason);
    }
  };
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const root = await factoryFor(
      definition,
      () => bindings,
      scopes,
      name
    )(input, undefined);
    if (signal?.aborted) {
      stop();
    }
    return await Workflow.attach(root, input).run();
  } catch (error) {
    if (isSuspendSignal(error)) {
      throw new Error(
        `"${name}" asked a person; run it with marbles to answer`,
        { cause: error }
      );
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", stop);
    await Promise.all([...scopes].map((scope) => scopes.settle(scope.id)));
  }
}
