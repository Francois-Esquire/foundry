import { AsyncIteratorClass, ORPCError } from "@orpc/server";
import { z } from "zod";
import { openModuleApp } from "~/main/modules/open-app";
import { ModuleRuntimeError } from "~/main/modules/runtime/controller";
import { base, requires } from "../context";

export const runtimeRouter = {
  open: base
    .use(requires(["builds", "sessions"], "Module runtime is unavailable"))
    .input(z.object({ id: z.string().min(1) }))
    .handler(({ context, input, signal }) =>
      openModuleApp(
        context.modules,
        context.builds,
        context.sessions,
        input.id,
        signal
      )
    ),
  start: base
    .use(requires(["sessions"]))
    .input(z.object({ contentId: z.string().min(1), id: z.string().min(1) }))
    .handler(({ context, input, signal }) => {
      const watch = context.sessions.watch(input.id, input.contentId, signal);
      return new AsyncIteratorClass(
        async () => {
          try {
            return await watch.next();
          } catch (error) {
            throw new ORPCError("PRECONDITION_FAILED", {
              cause: error,
              message:
                error instanceof ModuleRuntimeError
                  ? error.message
                  : "Module could not start. Check the runtime and released package.",
            });
          }
        },
        async () => {
          await watch.return();
        }
      );
    }),
};
