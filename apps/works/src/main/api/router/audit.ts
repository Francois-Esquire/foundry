import { base, requires } from "../context";

export const auditRouter = {
  watch: base
    .use(requires(["audit"]))
    .handler(({ context, signal }) => context.audit.watch(signal)),
};
