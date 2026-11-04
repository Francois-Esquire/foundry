import { z } from "zod";
import { base, refusals, requires } from "../context";

const id = z.object({ id: z.string().min(1) });
const grant = id.extend({ capability: z.string().min(1).max(200) });
const access = base.use(requires(["access"])).use(refusals);

/** Requests, Grants, approval and revocation: the only way a Module gains authority. */
export const accessRouter = {
  approve: access
    .input(grant)
    .handler(({ context, input }) =>
      context.access.approve(input.id, input.capability)
    ),
  get: access
    .input(id)
    .handler(({ context, input }) => context.access.get(input.id)),
  revoke: access
    .input(grant)
    .handler(({ context, input }) =>
      context.access.revoke(input.id, input.capability)
    ),
};
