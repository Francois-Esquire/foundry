import { Action } from "~/components/action";
import { KeyValue } from "~/components/ui/key-value";
import { Text } from "~/components/ui/text";
import type {
  DashboardSelection,
  HarnessActivitySnapshot,
  RunSnapshot,
} from "~/views/dashboard-model";
import { runStatusLabel } from "~/views/dashboard-model";

export function ActivityDetails({
  activity,
  run,
  onInspect,
}: {
  readonly activity: HarnessActivitySnapshot;
  readonly run: RunSnapshot;
  readonly onInspect: (selection: DashboardSelection) => void;
}) {
  return (
    <box flexDirection="column" gap={1}>
      <Action
        id="breadcrumb:run"
        label={run.id}
        onAction={onInspect}
        value={{ id: run.id, kind: "run" }}
      />
      <Text>
        <strong>{activity.title}</strong>
      </Text>
      <KeyValue
        items={[
          { key: "Kind", value: activity.kind },
          { key: "Status", value: runStatusLabel(activity) },
          { key: "Harness", value: activity.harness },
          { key: "Agent", value: activity.agentId },
          { key: "Lifetime", value: activity.lifetime },
          { key: "Session", value: activity.sessionId },
          { key: "Activity", value: activity.id },
          ...(activity.nativeId
            ? [{ key: "Native ID", value: activity.nativeId }]
            : []),
          ...(activity.parentId
            ? [{ key: "Parent", value: activity.parentId }]
            : []),
        ]}
      />
      {activity.summary && <Text>{activity.summary}</Text>}
      {activity.attention && <Text>Open the Feed to respond.</Text>}
    </box>
  );
}
