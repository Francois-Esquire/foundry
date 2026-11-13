import { useEffect, useLayoutEffect, useState } from "react";
import { z } from "zod";

const connectionSchema = z.strictObject({
  binding: z.string().min(1).nullable(),
  nonce: z.uuid(),
  type: z.literal("foundry.editor-state/connect"),
  version: z.literal(1),
  view: z.literal("editor"),
});

type Connection = z.infer<typeof connectionSchema>;

/** The parent requests a private reporting channel; dirty state never uses window messages. */
export class EditorStateConnection {
  readonly #page: Window;
  #connection: Connection | null = null;
  #port: MessagePort | null = null;
  #dirty = false as boolean;

  constructor(page: Window) {
    this.#page = page;
  }

  start(): () => void {
    this.#page.addEventListener("message", this.#connect);
    this.#page.parent.postMessage(
      { type: "foundry.editor-state/ready", version: 1 },
      "*"
    );
    return () => {
      this.#page.removeEventListener("message", this.#connect);
      this.#disconnect();
    };
  }

  setDirty(dirty: boolean): void {
    if (dirty !== this.#dirty) {
      this.#dirty = dirty;
      this.#report();
    }
  }

  readonly #connect = (event: MessageEvent<unknown>): void => {
    if (event.source !== this.#page.parent) {
      return;
    }
    const parsed = connectionSchema.safeParse(event.data);
    if (!parsed.success) {
      return;
    }
    const binding = new URL(this.#page.location.href).searchParams.get(
      "binding"
    );
    if (event.ports.length !== 1 || parsed.data.binding !== binding) {
      for (const port of event.ports) {
        port.close();
      }
      return;
    }
    this.#disconnect();
    this.#connection = parsed.data;
    this.#port = event.ports[0] ?? null;
    this.#report();
  };

  #report(): void {
    if (!(this.#port && this.#connection)) {
      return;
    }
    try {
      this.#port.postMessage({
        ...this.#connection,
        dirty: this.#dirty,
        type: "foundry.editor-state/report",
      });
    } catch {
      // Losing a report must not clear the host's last guard or fail an edit.
      this.#disconnect();
    }
  }

  #disconnect(): void {
    this.#port?.close();
    this.#port = null;
    this.#connection = null;
  }
}

/** React owns the current dirty value; the connection only retains it for handshakes. */
export function useEditorState(dirty: boolean): void {
  const [connection] = useState(() => new EditorStateConnection(window));
  useLayoutEffect(() => connection.setDirty(dirty), [connection, dirty]);
  useEffect(() => connection.start(), [connection]);
  useEffect(() => {
    if (!dirty) {
      return;
    }
    const prevent = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
}
