import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { base, requires } from "../context";
import { revision, source } from "./modules";

const turn = z.object({
  id: z.string().min(1),
  turnId: z.string().min(1),
});

const answer = z.discriminatedUnion("kind", [
  z.object({
    answers: z.record(
      z.string().min(1),
      z.array(z.string().min(1).max(16_384)).min(1).max(64)
    ),
    kind: z.literal("answer"),
  }),
  z.object({
    kind: z.literal("decline"),
    reason: z.string().max(2000).optional(),
  }),
  z.object({ approved: z.boolean(), kind: z.literal("approval") }),
]);

async function attempt<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ORPCError) {
      throw error;
    }
    throw new ORPCError("PRECONDITION_FAILED", {
      cause: error,
      message: error instanceof Error ? error.message : "Request failed",
    });
  }
}

const authoring = base.use(requires(["authoring"]));

export const authoringRouter = {
  accept: authoring
    .input(turn)
    .handler(({ context, input }) =>
      attempt(() => context.authoring.accept(input.id, input.turnId))
    ),
  answer: authoring
    .input(turn.extend({ answer, inputId: z.string().min(1) }))
    .handler(({ context, input }) =>
      attempt(() =>
        context.authoring.answer(
          input.id,
          input.turnId,
          input.inputId,
          input.answer
        )
      )
    ),
  cancel: authoring
    .input(turn)
    .handler(({ context, input }) =>
      attempt(() => context.authoring.cancel(input.id, input.turnId))
    ),
  proposal: authoring
    .input(turn)
    .handler(({ context, input }) =>
      attempt(() => context.authoring.proposal(input.id, input.turnId))
    ),
  send: authoring
    .input(
      z.object({
        binding: revision,
        id: z.string().min(1),
        prompt: z.string().trim().min(1).max(32_768),
        source,
      })
    )
    .handler(({ context, input }) =>
      attempt(() =>
        context.authoring.send(input.id, {
          binding: input.binding,
          prompt: input.prompt,
          source: input.source,
        })
      )
    ),
  settle: authoring
    .input(turn.extend({ status: z.enum(["applied", "dismissed"]) }))
    .handler(({ context, input }) =>
      attempt(() =>
        context.authoring.settleProposal(input.id, input.turnId, input.status)
      )
    ),
  watch: authoring
    .input(z.object({ id: z.string().min(1) }))
    .handler(({ context, input, signal }) =>
      context.authoring.watch(input.id, signal)
    ),
};
