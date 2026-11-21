import { useEffect, useState } from "react";
import type { RunStreamView } from "~/components/blocks/run-stream";
import type { RunActions } from "../state/run-actions";
import { appendStream, streamDelta, streamTail } from "../state/run-stream";

export function useRunStream(
  runId: string,
  stepId: string | undefined,
  source: RunActions["stream"] | undefined
): RunStreamView {
  const [text, setText] = useState("");
  const [live, setLive] = useState(false);
  useEffect(() => {
    setText("");
    const controller = new AbortController();
    const stream = source?.(runId, controller.signal);
    if (!stream) {
      setLive(false);
      return;
    }
    setLive(true);
    const reader = stream.getReader();
    const read = async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            return;
          }
          const delta = streamDelta(value, stepId);
          if (delta !== undefined) {
            setText((previous) => appendStream(previous, delta));
          }
        }
      } finally {
        if (!controller.signal.aborted) {
          setLive(false);
        }
      }
    };
    read().catch(() => undefined);
    return () => {
      controller.abort();
      reader.cancel().catch(() => undefined);
    };
  }, [runId, stepId, source]);
  return { lines: streamTail(text), live, received: text.length > 0 };
}
