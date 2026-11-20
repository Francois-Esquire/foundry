import type { ReactNode } from "react";
import { ActivityDetails } from "~/components/blocks/activity-details";
import { CatalogDetails } from "~/components/blocks/catalog-details";
import { RunInspector } from "~/components/blocks/run-inspector";
import { RunStream } from "~/components/blocks/run-stream";
import { Panel } from "~/components/ui/panel";
import { Text } from "~/components/ui/text";
import { useRunStream } from "../hooks/use-run-stream";
import {
  type DashboardSelection,
  type DashboardSnapshot,
  type ResolvedSelection,
  selectionKey,
} from "../state/dashboard-model";
import type { InspectorTab } from "../state/dashboard-state";
import type { CatalogSelection } from "../state/dashboard-tree";
import {
  type InspectorSubject,
  inspectorSubject,
  type RunStreamTarget,
} from "../state/inspector";
import type { RunActions } from "../state/run-actions";
import { STREAM_TAIL_LINES } from "../state/run-stream";

function LiveRunStream({
  target,
  source,
}: {
  readonly target: RunStreamTarget;
  readonly source?: RunActions["stream"];
}) {
  const stream = useRunStream(
    target.runId,
    target.stepId,
    target.local ? source : undefined
  );
  return <RunStream stream={stream} tail={STREAM_TAIL_LINES} />;
}

interface InspectorProps {
  readonly active: boolean;
  readonly configuration: boolean;
  readonly onFilter: (selection: CatalogSelection) => void;
  readonly onInspect: (selection: DashboardSelection) => void;
  readonly onLaunch?: (id: string) => void;
  readonly onRollSchedule?: (key: string) => void;
  readonly onTab: (tab: InspectorTab) => void;
  readonly onToggleConfiguration: () => void;
  readonly resolved: ResolvedSelection;
  readonly selection?: DashboardSelection;
  readonly snapshot: DashboardSnapshot;
  readonly stream?: RunActions["stream"];
  readonly tab: InspectorTab;
}

function subjectContent(
  subject: InspectorSubject,
  subjectKey: string | undefined,
  props: InspectorProps
): ReactNode {
  switch (subject.kind) {
    case "message":
      return <Text>{subject.message}</Text>;
    case "activity":
      return (
        <ActivityDetails
          activity={subject.activity}
          onInspect={props.onInspect}
        />
      );
    case "run":
      return (
        <RunInspector
          focused={props.active}
          inspector={subject.inspector}
          key={subjectKey}
          onInspect={props.onInspect}
          onTab={props.onTab}
          stream={
            <LiveRunStream source={props.stream} target={subject.stream} />
          }
          tab={props.tab}
        />
      );
    default:
      return (
        <CatalogDetails
          configuration={props.configuration}
          details={subject.details}
          key={subjectKey}
          onFilter={props.onFilter}
          onInspect={props.onInspect}
          onLaunch={subject.launchable ? props.onLaunch : undefined}
          onRollSchedule={subject.runNow ? props.onRollSchedule : undefined}
          onToggleConfiguration={props.onToggleConfiguration}
        />
      );
  }
}

export function Inspector(props: InspectorProps) {
  const { snapshot, resolved, selection, active, tab } = props;
  const subject = inspectorSubject(snapshot, resolved);
  const key = selection && selectionKey(selection);
  return (
    <Panel
      active={active}
      resetKey={key && `${key}:${tab}`}
      scrollable={active}
      title={subject.title}
    >
      {subjectContent(subject, key, props)}
    </Panel>
  );
}
