import { Action } from "~/components/ui/action";
import { KeyValue } from "~/components/ui/key-value";
import { SelectableRow } from "~/components/ui/selectable-row";
import { Text } from "~/components/ui/text";
import type { Fact } from "./activity-details";
import { StatusLabel, type StatusView } from "./status-label";

interface CatalogRunRow<S> {
  readonly key: string;
  readonly runId: string;
  readonly selection: S;
  readonly status: StatusView;
}

export type ConfigurationView =
  | { readonly expanded: false }
  | { readonly expanded: true; readonly text: string };

export interface CatalogDetailsView<S, F> {
  readonly description: string;
  readonly facts: readonly Fact[];
  readonly filter: F;
  readonly id: string;
  readonly runs: readonly CatalogRunRow<S>[];
}

function Configuration({
  configuration,
  onToggle,
}: {
  readonly configuration: ConfigurationView;
  readonly onToggle: () => void;
}) {
  return (
    <>
      <Action
        label={
          configuration.expanded
            ? "v Hide configuration"
            : "v Show configuration"
        }
        onAction={onToggle}
        value="configuration"
      />
      {configuration.expanded && <Text>{configuration.text}</Text>}
    </>
  );
}

export function CatalogDetails<S, F>({
  details,
  configuration,
  onToggleConfiguration,
  onInspect,
  onFilter,
  onLaunch,
  onRollSchedule,
}: {
  readonly details: CatalogDetailsView<S, F>;
  readonly configuration?: ConfigurationView;
  readonly onToggleConfiguration: () => void;
  readonly onInspect: (selection: S) => void;
  readonly onFilter: (filter: F) => void;
  readonly onLaunch?: (id: string) => void;
  readonly onRollSchedule?: (id: string) => void;
}) {
  const { runs } = details;
  return (
    <box flexDirection="column" flexShrink={0} gap={1}>
      <Text>{details.description}</Text>
      <KeyValue items={details.facts} />
      {configuration && (
        <Configuration
          configuration={configuration}
          onToggle={onToggleConfiguration}
        />
      )}
      {onRollSchedule && (
        <Action
          id="schedule:run"
          label="r Run now"
          onAction={onRollSchedule}
          value={details.id}
        />
      )}
      {onLaunch && (
        <Action
          active
          id="catalog:launch"
          label="l Launch"
          onAction={onLaunch}
          value={details.id}
        />
      )}
      <Action
        id="filter:runs"
        label={`f Show these runs (${runs.length})`}
        onAction={onFilter}
        value={details.filter}
      />
      {runs.length === 0 && <Text>No runs recorded.</Text>}
      {runs.map((run) => (
        <SelectableRow
          id={`detail:${run.key}`}
          key={run.key}
          onSelect={onInspect}
          selected={false}
          value={run.selection}
        >
          <Text>{run.runId}</Text>
          <StatusLabel status={run.status} />
        </SelectableRow>
      ))}
    </box>
  );
}
