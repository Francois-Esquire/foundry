import { z } from "zod";
import { base, requires } from "../context";

const id = z.object({ id: z.string().min(1) });
const power = base.use(requires(["power"]));

/** Module on/off: off stops its apps and sandbox; on lets them start again. */
export const powerRouter = {
  get: power
    .input(id)
    .handler(({ context, input }) => context.power.get(input.id)),
  set: power
    .input(id.extend({ on: z.boolean() }))
    .handler(({ context, input }) => context.power.set(input.id, input.on)),
};
