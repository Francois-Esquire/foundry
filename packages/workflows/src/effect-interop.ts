import { Cause, Effect, Exit, Option } from "effect";

export function resolveInput<T>(input: T | undefined, bound: T): T {
  if (input === undefined) {
    return bound;
  }
  return input;
}

export function runEffectPromise<A>(
  effect: Effect.Effect<A, Error>
): Promise<A> {
  return Effect.runPromiseExit(effect).then((exit) => {
    if (Exit.isSuccess(exit)) {
      return exit.value;
    }
    const failure = Cause.failureOption(exit.cause);
    if (Option.isSome(failure)) {
      throw failure.value;
    }
    const defect = Cause.dieOption(exit.cause);
    if (Option.isSome(defect)) {
      const d: unknown = defect.value;
      if (
        typeof d === "object" &&
        d !== null &&
        "_tag" in d &&
        d._tag === "UnknownException" &&
        "error" in d &&
        d.error instanceof Error
      ) {
        throw d.error;
      }
      throw d instanceof Error ? d : new Error(String(d));
    }
    throw new Error(Cause.pretty(exit.cause));
  });
}

export function errorToShape(err: unknown): {
  name: string;
  message: string;
  stack?: string;
} {
  if (err instanceof Error) {
    return {
      message: err.message,
      name: err.name,
      ...(err.stack ? { stack: err.stack } : {}),
    };
  }
  return { message: String(err), name: "Error" };
}
