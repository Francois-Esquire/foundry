import type { StepContext } from "@foundry/workflows/step";

import { Step } from "@foundry/workflows/step";

/**
 * `loop until` for `@foundry/workflows`, authored outside the package.
 *
 * The graph builder offers `sequence | parallel | race | branch` and no
 * repetition, so a cycle has to be expressed as a Step that drives its own
 * body. This is the exploratory shape: if it holds up, the same semantics
 * belong in the builder as `graph.loop(...)` (see REQUIREMENTS.md § API
 * findings).
 */

/** What one completed round of the body reports back to the loop. */
export interface LoopRound<O> {
  readonly output: O;
  readonly round: number;
}

/**
 * Any reusable definition — a Step or a Workflow. Both expose `create()`,
 * which is the only capability the loop needs, so the loop asks for exactly
 * that rather than for one of the two classes.
 */
export interface LoopBody<I, O> {
  create(): { run(input: I): Promise<O> };
}

export interface LoopUntilOptions<I, O> {
  /** The body driven once per round. */
  readonly body: LoopBody<I, O>;
  readonly definitionKey?: string;
  /** Hard ceiling; reaching it ends the loop with `settled: false`. */
  readonly maxRounds: number;
  readonly name?: string;
  /** Input for the next round, given the round that just finished. */
  readonly next: (round: LoopRound<O>, previous: I) => I;
  /** True ends the loop; the round that produced `output` is the last. */
  readonly until: (round: LoopRound<O>) => boolean | Promise<boolean>;
}

/** JSON-safe, because Step asserts its output is serializable. */
export interface LoopUntilResult<O> {
  /** Output of the final round. */
  readonly output: O;
  /** How many rounds actually ran. */
  readonly rounds: number;
  /** Whether `until` was satisfied, as opposed to `maxRounds` being hit. */
  readonly settled: boolean;
}

export class LoopUntil<I, O> extends Step<I, LoopUntilResult<O>> {
  readonly definitionKey: string;
  declare readonly name: string;
  readonly #options: LoopUntilOptions<I, O>;

  constructor(options: LoopUntilOptions<I, O>) {
    super();
    if (options.maxRounds < 1) {
      throw new Error("loopUntil: maxRounds must be at least 1");
    }
    this.#options = options;
    this.definitionKey = options.definitionKey ?? "quirks.loop-until";
    this.name = options.name ?? "Loop until";
  }

  protected async execute(
    input: I,
    ctx: StepContext<I, LoopUntilResult<O>>
  ): Promise<LoopUntilResult<O>> {
    const { body, until, next, maxRounds } = this.#options;
    // A reusable definition Step has no substrate of its own, so `ctx.invoke`
    // cannot drive it. `create()` is the supported way in: it materializes one
    // fresh runtime per round, which is also what keeps rounds independent.
    const bound = body.create();
    let current = input;

    for (let round = 1; ; round += 1) {
      ctx.log("debug", `loop round ${String(round)}`);
      const output = await bound.run(current);
      const completed: LoopRound<O> = { output, round };

      if (await until(completed)) {
        ctx.log("info", `loop settled after ${String(round)} round(s)`);
        return { output, rounds: round, settled: true };
      }
      if (round >= maxRounds) {
        ctx.log("warn", `loop hit maxRounds (${String(maxRounds)}) unsettled`);
        return { output, rounds: round, settled: false };
      }
      current = next(completed, current);
    }
  }
}

/** Function form, so a graph reads `graph.step("loop", loopUntil({...}))`. */
export function loopUntil<I, O>(
  options: LoopUntilOptions<I, O>
): LoopUntil<I, O> {
  return new LoopUntil(options);
}
