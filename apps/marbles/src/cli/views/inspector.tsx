import type { ReactNode } from "react";
import { ActivityDetails } from "~/components/blocks/activity-details";
import { CatalogDetails } from "~/components/blocks/catalog-details";
import { RunInspector } from "~/components/blocks/run-inspector";
import { RunStream } from "~/components/blocks/run-stream";
import { Panel } from "~/components/ui/panel";
import { Text } from "~/components/ui/text";
import { useRunStream } from "../hooks/use-run-stream";
import { selectionKey } from "../state/dashboard-model";
import {
  catalogConfiguration,
  type InspectorModel,
  type InspectorSubject,
  inspectorSubject,
  type RunStreamTarget,
  runTab,
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

function subjectContent(
  subject: InspectorSubject,
  subjectKey: string | undefined,
  props: InspectorModel
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
          body={runTab(props.snapshot, subject.run, subject.path, props.tab)}
          breadcrumbs={subject.breadcrumbs}
          focused={props.active}
          key={subjectKey}
          onInspect={props.onInspect}
          onTab={props.onTab}
          stream={
            <LiveRunStream source={props.stream} target={subject.stream} />
          }
        />
      );
    default:
      return (
        <CatalogDetails
          configuration={catalogConfiguration(
            subject.configuration,
            props.configurationShown
          )}
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

export function Inspector(props: InspectorModel) {
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
