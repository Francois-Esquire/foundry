import { useEffect, useState } from "react";
import {
  EDITOR_STATE_VERSION,
  type EditorStateConnect,
  editorStateReport,
  isEditorStateReady,
} from "~/shared/editor-state";

export type EditorFrameState = "clean" | "dirty" | "none" | "unknown";

export function guardsEditorFrame(state: EditorFrameState): boolean {
  return state === "dirty" || state === "unknown";
}

interface EditorFrameMount {
  readonly binding: string | null;
  readonly origin: string;
  readonly view: string;
}

export function useEditorFrameState(
  frame: HTMLIFrameElement | null,
  mount: EditorFrameMount
): EditorFrameState {
  const { binding, origin, view } = mount;
  const initial: EditorFrameState = "none";
  const key = `${origin}\n${binding ?? ""}\n${view}`;
  const [state, setState] = useState<{
    readonly key: string;
    readonly value: EditorFrameState;
  }>({ key, value: initial });
  if (state.key !== key) {
    const next = state.value === "clean" ? "unknown" : state.value;
    setState({ key, value: next });
  }
  useEffect(() => {
    if (!frame) {
      setState((lost) =>
        lost.key === key && lost.value === "clean"
          ? { key, value: "unknown" }
          : lost
      );
      return;
    }
    setState((shown) =>
      shown.key === key && shown.value === "none"
        ? { key, value: "unknown" }
        : shown
    );
    let current: { readonly nonce: string; readonly port: MessagePort } | null =
      null;
    const connect = () => {
      const target = frame.contentWindow;
      if (!target) {
        return;
      }
      current?.port.close();
      setState((previous) =>
        previous.key === key && previous.value === "clean"
          ? { key, value: "unknown" }
          : previous
      );
      const channel = new MessageChannel();
      const connection = { nonce: crypto.randomUUID(), port: channel.port1 };
      current = connection;
      connection.port.onmessage = (event: MessageEvent) => {
        const report = editorStateReport(event.data);
        if (
          report &&
          current === connection &&
          report.nonce === connection.nonce &&
          report.binding === binding &&
          report.view === view
        ) {
          setState({ key, value: report.dirty ? "dirty" : "clean" });
        }
      };
      const message: EditorStateConnect = {
        binding,
        nonce: connection.nonce,
        type: "foundry.editor-state/connect",
        version: EDITOR_STATE_VERSION,
        view,
      };
      target.postMessage(message, origin, [channel.port2]);
    };
    const ready = (event: MessageEvent) => {
      if (
        event.source === frame.contentWindow &&
        event.origin === origin &&
        isEditorStateReady(event.data)
      ) {
        connect();
      }
    };
    window.addEventListener("message", ready);
    frame.addEventListener("load", connect);
    return () => {
      window.removeEventListener("message", ready);
      frame.removeEventListener("load", connect);
      current?.port.close();
      current = null;
    };
  }, [binding, frame, key, origin, view]);
  return state.key === key ? state.value : initial;
}
