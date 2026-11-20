import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";
import { statusDisplay } from "~/model/run-status";
import type { LiveWorkSnapshot } from "~/views/dashboard-model";
import { workLabel } from "~/views/run-actions";

const INPUT: Readonly<Record<LiveWorkSnapshot["input"], string>> = {
  none: "· output only",
  stdin: "· s input: a line to its stdin, not a terminal",
  steer: "· s steer: interrupts the turn with your prompt",
};

function LiveWorkRow({ work }: { readonly work: LiveWorkSnapshot }) {
  const waiting = work.attention
    ? statusDisplay({ attention: work.attention, status: "running" }).label
    : undefined;
  return (
    <box flexDirection="row" flexShrink={0} gap={1}>
      <text
        fg={work.kind === "agent" ? theme.colors.accent : theme.colors.info}
      >
        {work.kind === "agent" ? "◆" : "▸"}
      </text>
      <Text wrapMode="none">
        {workLabel(work)} in {work.stepId}
      </Text>
      {waiting ? (
        <text fg={theme.colors.warning}>· {waiting} · i answer</text>
      ) : (
        <text fg={theme.colors.mutedForeground}>{INPUT[work.input]}</text>
      )}
    </box>
  );
}

export function LiveWork({
  work,
}: {
  readonly work: readonly LiveWorkSnapshot[];
}) {
  if (work.length === 0) {
    return null;
  }
  return (
    <box flexDirection="column" flexShrink={0}>
      <text fg={theme.colors.mutedForeground}>Live now</text>
      {work.map((item) => (
        <LiveWorkRow key={item.id} work={item} />
      ))}
    </box>
  );
}
