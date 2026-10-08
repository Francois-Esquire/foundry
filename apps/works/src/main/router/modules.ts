import { ModulePackageError } from "@foundry/modules/package";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { base } from "./context";

export const modulesRouter = {
  create: base
    .input(z.object({ name: z.string().trim().min(1).max(120) }))
    .handler(({ context, input }) => context.modules.create(input.name)),
  details: base
    .input(z.object({ id: z.string().min(1) }))
    .handler(async ({ context, input }) => {
      const details = await context.modules.details(input.id);
      if (!details) {
        throw new ORPCError("NOT_FOUND", { message: "Module not found" });
      }
      return details;
    }),
  importPackage: base
    .input(
      z.object({
        encoded: z
          .string()
          .min(1)
          .max(32 * 1024 * 1024),
      })
    )
    .handler(async ({ context, input }) => {
      try {
        return await context.modules.importPackage(input.encoded);
      } catch (error) {
        if (error instanceof ModulePackageError) {
          throw new ORPCError("BAD_REQUEST", {
            cause: error,
            message: error.message,
          });
        }
        throw error;
      }
    }),
  list: base.handler(({ context }) => context.modules.list()),
};
