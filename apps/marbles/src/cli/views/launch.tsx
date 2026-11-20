import { useKeyboard } from "@opentui/react";
import { useCallback } from "react";
import { useAsyncAction } from "~/cli/hooks/use-async-action";
import { useQuitGuard } from "~/cli/hooks/use-quit-guard";
import { ArgumentForm } from "~/components/blocks/argument-form";
import { QuitDialog } from "~/components/blocks/quit-dialog";
import { SetupFlow } from "~/components/layouts/setup-flow";
import { Action } from "~/components/ui/action";
import { Text } from "~/components/ui/text";
import {
  type InputField,
  type InputValues,
  inputDefaults,
  inputProblem,
  parseInputs,
} from "~/lib/inputs";
import type { DefinitionSnapshot } from "../state/dashboard-model";
import type { Launcher } from "../state/run-actions";

function LaunchForm({
  fields,
  ...form
}: {
  readonly fields: readonly InputField[];
  readonly active: boolean;
  readonly busy: boolean;
  readonly error?: string;
  readonly onCancel: () => void;
  readonly onSubmit: (input: InputValues) => void;
}) {
  const parse = useCallback(
    (values: InputValues) => parseInputs(fields, values),
    [fields]
  );
  return (
    <ArgumentForm
      {...form}
      fields={fields}
      initialValues={inputDefaults(fields)}
      parse={parse}
      problem={inputProblem(fields)}
    />
  );
}

export function LaunchView({
  definition,
  onLaunch,
  onStarted,
  onCancel,
  onClose,
}: {
  readonly definition: DefinitionSnapshot;
  readonly onLaunch: Launcher;
  readonly onStarted: (id: string) => void;
  readonly onCancel: () => void;
  readonly onClose: () => void;
}) {
  const quit = useQuitGuard(onClose);
  const launch = useAsyncAction();
  const fields = definition.input?.fields;
  const problem = fields
    ? inputProblem(fields)
    : "Arguments are not declared for this definition. Add input metadata in your marble module, or use marbles roll with --input.";
  const submit = useCallback(
    (input: InputValues) => {
      if (!quit.quitting) {
        launch.run(async () => onStarted(await onLaunch(definition.id, input)));
      }
    },
    [definition.id, onLaunch, onStarted, quit.quitting, launch.run]
  );
  const cancel = useCallback(() => {
    if (!quit.quitting) {
      onCancel();
    }
  }, [onCancel, quit.quitting]);
  useKeyboard((key) => {
    if (quit.handleKey(key)) {
      return;
    }
    if (problem && key.name === "escape") {
      onCancel();
    }
  });
  return (
    <SetupFlow
      overlay={
        quit.quitting && (
          <QuitDialog onCancel={quit.cancel} onConfirm={onClose} />
        )
      }
      title={`Launch ${definition.name}`}
    >
      <Text>{definition.description}</Text>
      {problem ? (
        <box flexDirection="column">
          <Text>{problem}</Text>
          <Action
            id="launch:back"
            label="Esc · Back to catalog"
            onAction={cancel}
            value="back"
          />
        </box>
      ) : (
        <LaunchForm
          active={!quit.quitting}
          busy={launch.busy}
          error={launch.error}
          fields={fields ?? []}
          onCancel={onCancel}
          onSubmit={submit}
        />
      )}
    </SetupFlow>
  );
}
