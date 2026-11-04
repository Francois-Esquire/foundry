import type { ModuleGatewayInvocationRecord } from "@foundry/modules/gateway/types";
import type { TaskContext } from "@foundry.sh/marbles/engine";
import {
  type GatewayCall,
  OBSERVATION,
  type UnrecordedGatewayCalls,
} from "~/shared/observations";

/**
 * Gateway invocations recorded per Program lifetime run: a bound on the
 * record, not on what recording costs. Writing one is an append, but the
 * run's record carries every one, and each change goes whole to every
 * reader of the run store, such as the audit view. So a long-lived Program
 * records only its first calls one by one; later ones are counted and the
 * count is written when it stops.
 */
export const GATEWAY_CALLS_PER_PROGRAM = 500;

interface LiveProgram {
  readonly context: TaskContext;
  readonly recorded: Set<string>;
  unrecorded: number;
}

/**
 * Records each Gateway invocation of a Module's live Program on that
 * Program's lifetime run (one Program per Module at a time): Capability,
 * timing, outcome and failure code, never input or output.
 */
export class ProgramCalls {
  readonly #live = new Map<string, LiveProgram>();

  /** A Program is up: its Module's invocations record on this run until `detach`. */
  attach(moduleId: string, context: TaskContext): () => void {
    const program: LiveProgram = {
      context,
      recorded: new Set(),
      unrecorded: 0,
    };
    this.#live.set(moduleId, program);
    return () => {
      if (this.#live.get(moduleId) === program) {
        this.#live.delete(moduleId);
      }
      if (program.unrecorded > 0) {
        context.observe({
          data: {
            count: program.unrecorded,
          } satisfies UnrecordedGatewayCalls,
          id: OBSERVATION.gatewayUnrecorded,
          kind: "effect",
          type: OBSERVATION.gatewayUnrecorded,
        });
      }
    };
  }

  /** The dispatcher's observer. */
  record = (record: ModuleGatewayInvocationRecord): void => {
    const program = this.#live.get(record.principal.moduleId);
    if (!program) {
      return;
    }
    const known = program.recorded.has(record.invocationId);
    if (!known && program.recorded.size >= GATEWAY_CALLS_PER_PROGRAM) {
      if (record.status !== "running") {
        program.unrecorded += 1;
      }
      return;
    }
    program.recorded.add(record.invocationId);
    program.context.observe({
      data: {
        ...(record.capability === undefined
          ? {}
          : {
              capability: record.capability.name,
              version: record.capability.version,
            }),
        mode: record.mode,
        runtimeInstanceId: record.principal.runtimeInstanceId,
      } satisfies GatewayCall,
      ...ending(record),
      id: record.invocationId,
      kind: "effect",
      startedAt: record.startedAt,
      status: record.status,
      type: OBSERVATION.gateway,
    });
  };
}

/** When and how a settled invocation ended; nothing while a stream is open. */
function ending(record: ModuleGatewayInvocationRecord): {
  readonly endedAt?: string;
  readonly errorCode?: string;
} {
  if (record.status === "running") {
    return {};
  }
  return {
    endedAt: record.endedAt,
    ...("errorCode" in record && record.errorCode !== undefined
      ? { errorCode: record.errorCode }
      : {}),
  };
}
