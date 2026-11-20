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

export interface RunInspectorView<S> {
  readonly breadcrumbs: readonly Breadcrumb<S>[];
  readonly error?: string;
  readonly input?: JsonValue;
  readonly logs: readonly LogEntry[];
  readonly output?: JsonValue;
  readonly overview: InspectorOverview;
}

function Overview({ overview }: { readonly overview: InspectorOverview }) {
  return overview.kind === "step" ? (
    <StepOverview step={overview.step} />
  ) : (
    <RunOverview run={overview.run} />
  );
}

export function RunInspector<S>({
  inspector,
  focused,
  tab,
  onTab,
  onInspect,
  stream,
}: {
  readonly inspector: RunInspectorView<S>;
  readonly focused: boolean;
  readonly tab: InspectorTab;
  readonly onTab: (tab: InspectorTab) => void;
  readonly onInspect: (selection: S) => void;
  readonly stream: ReactNode;
}) {
  const tabs = [
    {
      content: <Overview overview={inspector.overview} />,
      key: "overview",
      label: "Overview",
    },
    {
      content: (
        <ValueViewer
          empty="No input recorded."
          focused={focused && tab === "input"}
          value={inspector.input}
        />
      ),
      key: "input",
      label: "Input",
    },
    {
      content: (
        <box flexDirection="column">
          {inspector.error && <Text>Error: {inspector.error}</Text>}
          <ValueViewer
            empty="No output recorded."
            focused={focused && tab === "output"}
            value={inspector.output}
          />
        </box>
      ),
      key: "output",
      label: "Output",
    },
    {
      content: (
        <Log entries={inspector.logs} focused={focused && tab === "logs"} />
      ),
      key: "logs",
      label: "Logs",
    },
    {
      content: tab === "stream" ? stream : null,
      key: "stream",
      label: "Stream",
    },
  ] as const;
  return (
    <box flexDirection="column" gap={1}>
      <box flexDirection="row" flexWrap="wrap" gap={1}>
        {inspector.breadcrumbs.map((crumb) => (
          <Action
            id={crumb.id}
            key={crumb.key}
            label={crumb.label}
            onAction={onInspect}
            value={crumb.selection}
          />
        ))}
      </box>
      <Tabs activeTab={tab} onTabChange={onTab} tabs={tabs} />
    </box>
  );
}
