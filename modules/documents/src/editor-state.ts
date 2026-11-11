interface Connection {
  readonly binding: string | null;
  readonly nonce: string;
  readonly type: "foundry.editor-state/connect";
  readonly version: 1;
  readonly view: string;
}

function connection(data: unknown): data is Connection {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return false;
  }
  const value = data as Record<string, unknown>;
  return (
    Object.keys(value).length === 5 &&
    value.type === "foundry.editor-state/connect" &&
    value.version === 1 &&
    typeof value.nonce === "string" &&
    value.nonce.length > 0 &&
    typeof value.view === "string" &&
    value.view.length > 0 &&
    (value.binding === null ||
      (typeof value.binding === "string" && value.binding.length > 0))
  );
}

/** The host owns navigation. Only its private, current port receives draft state. */
export function editorState(
  binding: () => string | null,
  dirty: () => boolean
): { report(): void; dispose(): void } {
  let active: { connection: Connection; port: MessagePort } | undefined;
  let reported: boolean | undefined;

  function report(): void {
    if (!active) {
      return;
    }
    const current = dirty();
    if (reported === current) {
      return;
    }
    active.port.postMessage({
      ...active.connection,
      dirty: current,
      type: "foundry.editor-state/report",
    });
    reported = current;
  }

  function connect(event: MessageEvent<unknown>): void {
    const [port] = event.ports;
    if (
      event.source !== window.parent ||
      !connection(event.data) ||
      event.data.binding !== binding() ||
      event.ports.length !== 1 ||
      !port
    ) {
      return;
    }
    active?.port.close();
    active = { connection: event.data, port };
    reported = undefined;
    report();
  }

  function dispose(): void {
    window.removeEventListener("message", connect);
    window.removeEventListener("pagehide", dispose);
    active?.port.close();
    active = undefined;
  }

  window.addEventListener("message", connect);
  window.addEventListener("pagehide", dispose);
  window.parent.postMessage(
    { type: "foundry.editor-state/ready", version: 1 },
    "*"
  );
  return { dispose, report };
}
