import { z } from "zod";
import { base, refusals, requires } from "../context";

const id = z.object({ id: z.string().min(1) });
const settings = base.use(requires(["moduleSettings"])).use(refusals);

/** Per-Module limits and preferences; Grants are managed in Access, not here. */
export const moduleSettingsRouter = {
  get: settings
    .input(id)
    .handler(({ context, input }) => context.moduleSettings.get(input.id)),
  set: settings
    .input(id.extend({ values: z.record(z.string(), z.number()) }))
    .handler(({ context, input }) =>
      context.moduleSettings.set(input.id, input.values)
    ),
};
