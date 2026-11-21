import { z } from "zod";

export const EDITOR_STATE_VERSION = 1;

const readySchema = z.strictObject({
  type: z.literal("foundry.editor-state/ready"),
  version: z.literal(EDITOR_STATE_VERSION),
});

export interface EditorStateConnect {
  readonly binding: string | null;
  readonly nonce: string;
  readonly type: "foundry.editor-state/connect";
  readonly version: typeof EDITOR_STATE_VERSION;
  readonly view: string;
}

const reportSchema = z.strictObject({
  binding: z.string().min(1).nullable(),
  dirty: z.boolean(),
  nonce: z.string().min(1),
  type: z.literal("foundry.editor-state/report"),
  version: z.literal(EDITOR_STATE_VERSION),
  view: z.string().min(1),
});

export type EditorStateReport = z.infer<typeof reportSchema>;

export function isEditorStateReady(data: unknown): boolean {
  return readySchema.safeParse(data).success;
}

export function editorStateReport(data: unknown): EditorStateReport | null {
  const parsed = reportSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}
