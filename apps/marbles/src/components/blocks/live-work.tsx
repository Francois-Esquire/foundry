import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";

export interface LiveWorkItem {
  readonly attention: boolean;
  readonly hint: string;
  readonly id: string;
  readonly kind: "agent" | "command";
  readonly label: string;
}

function LiveWorkRow({ work }: { readonly work: LiveWorkItem }) {
  return (
    <box flexDirection="row" flexShrink={0} gap={1}>
      <text
        fg={work.kind === "agent" ? theme.colors.accent : theme.colors.info}
      >
        {work.kind === "agent" ? "◆" : "▸"}
      </text>
      <Text wrapMode="none">{work.label}</Text>
      <text
        fg={
          work.attention ? theme.colors.warning : theme.colors.mutedForeground
        }
      >
        {work.hint}
      </text>
    </box>
  );
}

export function LiveWork({ work }: { readonly work: readonly LiveWorkItem[] }) {
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
