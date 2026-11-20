import type { ReactNode } from "react";
import { Action } from "~/components/ui/action";
import { Log } from "~/components/ui/log";
import { Tabs } from "~/components/ui/tabs";
import { Text } from "~/components/ui/text";
import type { JsonValue } from "~/model/json";
import type { LogEntry } from "~/model/log";
import {
  RunOverview,
  type RunOverviewView,
  StepOverview,
  type StepOverviewView,
} from "./run-overview";
import { ValueViewer } from "./value-viewer";

export type InspectorTab = "overview" | "input" | "output" | "logs" | "stream";

export interface Breadcrumb<S> {
  readonly id?: string;
  readonly key: string;
  readonly label: string;
  readonly selection: S;
}

type InspectorOverview =
  | { readonly kind: "run"; readonly run: RunOverviewView }
  | { readonly kind: "step"; readonly step: StepOverviewView };

export type RunTabView =
  | { readonly kind: "overview"; readonly overview: InspectorOverview }
  | { readonly input?: JsonValue; readonly kind: "input" }
  | {
      readonly error?: string;
      readonly kind: "output";
      readonly output?: JsonValue;
    }
  | { readonly kind: "logs"; readonly logs: readonly LogEntry[] }
  | { readonly kind: "stream" };

const TABS: readonly { readonly key: InspectorTab; readonly label: string }[] =
  [
    { key: "overview", label: "Overview" },
    { key: "input", label: "Input" },
    { key: "output", label: "Output" },
    { key: "logs", label: "Logs" },
    { key: "stream", label: "Stream" },
  ];

function Overview({ overview }: { readonly overview: InspectorOverview }) {
  return overview.kind === "step" ? (
    <StepOverview step={overview.step} />
  ) : (
    <RunOverview run={overview.run} />
  );
}

function tabContent(
  body: RunTabView,
  focused: boolean,
  stream: ReactNode
): ReactNode {
  switch (body.kind) {
    case "overview":
      return <Overview overview={body.overview} />;
    case "input":
      return (
        <ValueViewer
          empty="No input recorded."
          focused={focused}
          value={body.input}
        />
      );
    case "output":
      return (
        <box flexDirection="column">
          {body.error && <Text>Error: {body.error}</Text>}
          <ValueViewer
            empty="No output recorded."
            focused={focused}
            value={body.output}
          />
        </box>
      );
    case "logs":
      return <Log entries={body.logs} focused={focused} />;
    default:
      return stream;
  }
}

export function RunInspector<S>({
  breadcrumbs,
  body,
  focused,
  onTab,
  onInspect,
  stream,
  work,
}: {
  readonly breadcrumbs: readonly Breadcrumb<S>[];
  readonly body: RunTabView;
  readonly focused: boolean;
  readonly onTab: (tab: InspectorTab) => void;
  readonly onInspect: (selection: S) => void;
  readonly stream: ReactNode;
  readonly work?: ReactNode;
}) {
  const content = tabContent(body, focused, stream);
  const tabs = TABS.map((tab) => ({
    ...tab,
    content: tab.key === body.kind ? content : null,
  }));
  return (
    <box flexDirection="column" gap={1}>
      <box columnGap={1} flexDirection="row" flexWrap="wrap" rowGap={0}>
        {breadcrumbs.map((crumb) => (
          <Action
            id={crumb.id}
            key={crumb.key}
            label={crumb.label}
            onAction={onInspect}
            value={crumb.selection}
          />
        ))}
      </box>
      {work}
      <Tabs activeTab={body.kind} onTabChange={onTab} tabs={tabs} />
    </box>
  );
}
