import { z } from "zod";

import { CONTAINER_ROW_STATUSES } from "./container/constants";

export const containerRowStatusSchema = z.enum(CONTAINER_ROW_STATUSES);

export type ContainerRowStatus = z.infer<typeof containerRowStatusSchema>;

const timestampSchema = z.custom<number>((value) => typeof value === "number");

const containerRowObjectSchema = z.object({
  createdAt: timestampSchema,
  holder: z.string().optional(),
  id: z.string(),
  nativeId: z.string().or(z.undefined()),
  spec: z.string(),
  status: containerRowStatusSchema,
  updatedAt: timestampSchema,
});

export const containerRowSchema = containerRowObjectSchema.readonly();

export type ContainerRow = z.infer<typeof containerRowSchema>;

const changeEventFields = {
  at: z.iso.datetime(),
  containerId: z.string(),
  id: z.string().min(1),
};

export const sandboxEventSchema = z.discriminatedUnion("type", [
  z.object({ ...changeEventFields, type: z.literal("sandbox.created") }),
  z.object({ ...changeEventFields, type: z.literal("sandbox.started") }),
  z.object({ ...changeEventFields, type: z.literal("sandbox.stopped") }),
  z.object({ ...changeEventFields, type: z.literal("sandbox.failed") }),
  z.object({ ...changeEventFields, type: z.literal("sandbox.destroyed") }),
]);

export type SandboxEvent = z.infer<typeof sandboxEventSchema>;
