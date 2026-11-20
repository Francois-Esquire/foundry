import type { ChannelMessage } from "@foundry/workflows/channels";
import { useEffect, useState } from "react";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";
import type { RunActions } from "~/views/run-actions";

const TAIL_LINES = 12;
const MAX_CHARS = 20_000;

function under(path: readonly string[], stepId?: string): boolean {
  if (stepId === undefined) {
    return true;
  }
  const key = path.join(".");
  return key === stepId || key.startsWith(`${stepId}.`);
}

export function RunStream({
  runId,
  stepId,
  source,
}: {
  readonly runId: string;
  readonly stepId?: string;
  readonly source?: RunActions["stream"];
}) {
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
    return <Text>No output to show for this run.</Text>;
  }
  return (
    <box flexDirection="column" flexShrink={0}>
      {text.length === 0 && <Text>Waiting for output…</Text>}
      {lines.map((line, index) => (
        <Text key={`${String(index)}:${line}`} wrapMode="none">
          {line}
        </Text>
      ))}
      <text fg={theme.colors.mutedForeground}>
        {live ? "Live" : "Ended"} · last {String(TAIL_LINES)} lines · leaving
        this tab does not stop the work
      </text>
    </box>
  );
}
