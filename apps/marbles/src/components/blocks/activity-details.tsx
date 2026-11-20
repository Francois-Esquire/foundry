import { Action } from "~/components/ui/action";
import { KeyValue } from "~/components/ui/key-value";
import { Text } from "~/components/ui/text";

export interface Fact {
  readonly key: string;
  readonly value: string;
}

export interface ActivityView<S> {
  readonly breadcrumb: { readonly label: string; readonly selection: S };
  readonly facts: readonly Fact[];
  readonly summary?: string;
  readonly title: string;
  readonly waiting: boolean;
}

export function ActivityDetails<S>({
  activity,
  onInspect,
}: {
  readonly activity: ActivityView<S>;
  readonly onInspect: (selection: S) => void;
}) {
  return (
    <box flexDirection="column" gap={1}>
      <Action
        id="breadcrumb:run"
        label={activity.breadcrumb.label}
        onAction={onInspect}
        value={activity.breadcrumb.selection}
      />
      <Text>
        <strong>{activity.title}</strong>
      </Text>
      <KeyValue items={activity.facts} />
      {activity.summary && <Text>{activity.summary}</Text>}
      {activity.waiting && <Text>Open the Feed to respond.</Text>}
    </box>
  );
}
