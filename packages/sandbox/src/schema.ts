import { z } from "zod";

import { CONTAINER_ROW_STATUSES } from "./container/constants";

export const containerRowStatusSchema = z.enum(CONTAINER_ROW_STATUSES);

export type ContainerRowStatus = z.infer<typeof containerRowStatusSchema>;

const timestampSchema = z.custom<number>((value) => typeof value === "number");

const containerRowObjectSchema = z.object({
  createdAt: timestampSchema,
  id: z.string(),
  nativeId: z.string().or(z.undefined()),
  spec: z.string(),
  status: containerRowStatusSchema,
  updatedAt: timestampSchema,
});

export const containerRowSchema = containerRowObjectSchema.readonly();

export type ContainerRow = z.infer<typeof containerRowSchema>;
