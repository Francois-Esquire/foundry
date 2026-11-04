import { base, requires } from "../context";

/** Modules auditing: read-only, straight from the engine run store. */
export const auditRouter = {
  /** A snapshot of retained runs and retention gaps, then each change. */
  watch: base
    .use(requires(["audit"]))
    .handler(({ context, signal }) => context.audit.watch(signal)),
};
