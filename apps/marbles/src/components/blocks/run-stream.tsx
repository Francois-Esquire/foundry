import type { ChannelMessage } from "@foundry/workflows/channels";
import { useEffect, useState } from "react";
import { Text } from "~/components/ui/text";
import { useTheme } from "~/hooks/use-theme";
import type { RunActions } from "~/views/run-actions";

const TAIL_LINES = 12;
const MAX_CHARS = 20_000;

/** Whether a chunk written at `path` belongs to the step (or its subtree). */
function under(path: readonly string[], stepId?: string): boolean {
  if (stepId === undefined) {
    return true;
  }
  const key = path.join(".");
  return key === stepId || key.startsWith(`${stepId}.`);
}

/**
 * The live text a run's steps write: agent turns, `stream.write`, and the
 * `[steer]` and `[resume]` markers the host leaves. Read from the host's
 * subscription while this tab is showing, kept to a tail.
 */
export function RunStream({
  runId,
  stepId,
  source,
}: {
  readonly runId: string;
  readonly stepId?: string;
  readonly source?: RunActions["stream"];
}) {
  const theme = useTheme();
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
          const message: ChannelMessage = value;
          if (
            message._tag === "chunk" &&
            message.chunk.payload.kind === "text" &&
            under(message.chunk.path, stepId)
          ) {
            const delta = message.chunk.payload.text;
            setText((previous) => (previous + delta).slice(-MAX_CHARS));
          }
        }
      } catch {
        // The subscription ended with the run or the tab.
      } finally {
        setLive(false);
      }
    };
    read().catch(() => undefined);
    return () => {
      controller.abort();
      reader.cancel().catch(() => undefined);
    };
  }, [runId, stepId, source]);
  const lines = text.split("\n").slice(-TAIL_LINES);
  if (!(live || text)) {
    return <Text>No live stream: the run is not running in this process.</Text>;
  }
  return (
    <box flexDirection="column" flexShrink={0}>
      {text.length === 0 && <Text>Waiting for output…</Text>}
      {lines.map((line, index) => (
        <text
          fg={theme.colors.foreground}
          key={`${String(index)}:${line}`}
          wrapMode="none"
        >
          {line}
        </text>
      ))}
      <text fg={theme.colors.mutedForeground}>
        {live ? "Live" : "Ended"} · last {String(TAIL_LINES)} lines · s steer ·
        p pause
      </text>
    </box>
  );
}
