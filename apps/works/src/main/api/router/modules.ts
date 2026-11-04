import { ModulePackageError } from "@foundry/modules/package";
import { ModuleStoreConflictError } from "@foundry/modules/store/contract";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { sourceAdmissionProblem } from "~/main/modules/source-admission";
import { base, requires } from "../context";

export const revision = z.object({
  artifactId: z.string().min(1),
  contentId: z.string().min(1),
  updatedAt: z.iso.datetime(),
});
export const source = z
  .record(z.string(), z.string())
  .superRefine((files, context) => {
    const problem = sourceAdmissionProblem(files);
    if (problem !== null) {
      context.addIssue({ code: "custom", message: problem });
    }
  });

export const modulesRouter = {
  build: base
    .use(requires(["builds"]))
    .input(
      z.object({
        expected: revision,
        id: z.string().min(1),
        tag: z.string().min(1).max(120),
      })
    )
    .handler(({ context, input, signal }) => {
      try {
        return context.builds.watch(
          input.id,
          input.tag,
          input.expected,
          signal
        );
      } catch (error) {
        throw new ORPCError("PRECONDITION_FAILED", {
          cause: error,
          message:
            error instanceof Error ? error.message : "Build could not start",
        });
      }
    }),
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
  saveSource: base
    .input(z.object({ expected: revision, id: z.string().min(1), source }))
    .handler(async ({ context, input }) => {
      try {
        return await context.modules.saveSource(
          input.id,
          input.source,
          input.expected
        );
      } catch (error) {
        throw new ORPCError(
          error instanceof ModuleStoreConflictError
            ? "CONFLICT"
            : "BAD_REQUEST",
          {
            cause: error,
            message:
              error instanceof Error
                ? error.message
                : "Source could not be saved",
          }
        );
      }
    }),
};
