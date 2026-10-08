import { ModulePackageError } from "@foundry/modules/package";
import { ModuleStoreConflictError } from "@foundry/modules/store/contract";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { base } from "../context";

const revision = z.object({
  artifactId: z.string().min(1),
  contentId: z.string().min(1),
  updatedAt: z.iso.datetime(),
});
const source = z
  .record(z.string().min(1).max(512), z.string().max(4 * 1024 * 1024))
  .refine(
    (files) =>
      Object.keys(files).length <= 2048 &&
      Object.values(files).reduce(
        (total, file) => total + new TextEncoder().encode(file).byteLength,
        0
      ) <=
        16 * 1024 * 1024,
    "Source exceeds the workspace limit"
  );

export const modulesRouter = {
  build: base
    .input(
      z.object({
        expected: revision,
        id: z.string().min(1),
        tag: z.string().min(1).max(120),
      })
    )
    .handler(({ context, input, signal }) => {
      if (!context.builds) {
        throw new ORPCError("SERVICE_UNAVAILABLE", {
          message: "Module builds are unavailable",
        });
      }
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
