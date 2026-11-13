import { z } from "zod";

/**
 * Editor state, version 1: how an editor View tells the Works window it
 * hosts it in whether it holds unsaved work, so leaving the View or quitting
 * asks first. The View announces itself with {@link EditorStateReady}
 * (`window.parent.postMessage(ready, "*")`, carrying nothing); Works answers
 * on every frame load and every valid ready with {@link EditorStateConnect},
 * posted only to that frame's window at the View's exact origin and carrying
 * a fresh nonce and a dedicated MessagePort. The View reports
 * {@link EditorStateReport} on that port only: once at once, then whenever
 * `dirty` changes. Works accepts a report only on the current port, with the
 * current nonce and the binding and View it mounted.
 *
 * A View checks `event.source === window.parent` and its own binding, never
 * the host's origin: the packaged window is a `file://` document whose
 * messages arrive from the opaque origin `"null"`.
 */
export const EDITOR_STATE_VERSION = 1;

/** A View, listening now, asks Works to connect. */
const readySchema = z.strictObject({
  type: z.literal("foundry.editor-state/ready"),
  version: z.literal(EDITOR_STATE_VERSION),
});

/** Works to the View: the port to report on, for this mount. */
export interface EditorStateConnect {
  /** The editor binding the View was opened with; null without one. */
  readonly binding: string | null;
  /** Fresh for each connection; a report names the one it answers. */
  readonly nonce: string;
  readonly type: "foundry.editor-state/connect";
  readonly version: typeof EDITOR_STATE_VERSION;
  /** The Manifest View id Works mounted. */
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

/** The View to Works, on the connected port: whether it holds unsaved work. */
export type EditorStateReport = z.infer<typeof reportSchema>;

export function isEditorStateReady(data: unknown): boolean {
  return readySchema.safeParse(data).success;
}

/** A well-formed report, or null for anything else. */
export function editorStateReport(data: unknown): EditorStateReport | null {
  const parsed = reportSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}
