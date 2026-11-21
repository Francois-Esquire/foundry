import { z } from "zod";
import { base, refusals, requires } from "../context";

const id = z.object({ id: z.string().min(1) });
const artifacts = base.use(requires(["artifacts"])).use(refusals);

export const artifactsRouter = {
  create: artifacts
    .input(z.object({ name: z.string().trim().min(1).max(120) }))
    .handler(({ context, input }) => context.artifacts.create(input)),
  list: artifacts.handler(({ context }) => context.artifacts.list()),
  open: artifacts
    .input(
      id.extend({
        contentId: z.string().min(1),
        entry: z.string().min(1),
        moduleId: z.string().min(1),
        view: z.string().min(1),
      })
    )
    .handler(({ context, input }) => context.artifacts.open(input)),
  resolve: artifacts
    .input(id.extend({ entry: z.string().min(1).optional() }))
    .handler(({ context, input }) => context.artifacts.resolve(input)),
  thumbnail: artifacts
    .input(id)
    .handler(({ context, input }) => context.artifacts.thumbnail(input)),
};
