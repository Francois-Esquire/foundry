import { ToolCall } from "@/components/ui/tool-call";
import { useTheme } from "@/hooks/use-theme";
import type { ToolUse } from "@/model/thread";

export function ToolRow({ tool }: { readonly tool: ToolUse }) {
  const theme = useTheme();
  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1}>
        <box flexShrink={0}>
          <ToolCall collapsible={false} name={tool.name} status={tool.status} />
        </box>
        <text
          fg={theme.colors.mutedForeground}
          flexShrink={1}
          truncate
          wrapMode="none"
        >
          {tool.detail}
        </text>
      </box>
      {tool.error ? (
        <box paddingLeft={2}>
          <text fg={theme.colors.mutedForeground} truncate wrapMode="none">
            {tool.error}
          </text>
        </box>
      ) : null}
    </box>
  );
}
