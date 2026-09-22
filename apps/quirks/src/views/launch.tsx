import { useKeyboard } from "@opentui/react";
import { useCallback, useRef, useState } from "react";
import { Action } from "~/components/action";
import { ArgumentForm } from "~/components/blocks/argument-form";
import { QuitDialog } from "~/components/blocks/quit-dialog";
import { SetupFlow } from "~/components/ui/setup-flow";
import { inputProblem } from "~/lib/inputs";
import type { DefinitionSnapshot } from "./dashboard-model";

export function LaunchView({
  definition,
  onLaunch,
  onStarted,
  onCancel,
  onClose,
}: {
  readonly definition: DefinitionSnapshot;
  readonly onLaunch: (name: string, input: unknown) => Promise<string>;
  readonly onStarted: (id: string) => void;
  readonly onCancel: () => void;
  readonly onClose: () => void;
}) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [quitting, setQuitting] = useState(false);
  const pending = useRef(new Set<string>());
  const fields = definition.input?.fields;
  const problem = fields
    ? inputProblem(fields)
    : "Arguments are not declared for this definition. Add input metadata in quirks.config.ts, or use quirks once with --input.";
  const submit = useCallback(
    async (input: unknown) => {
      if (pending.current.has("submit") || quitting) {
        return;
      }
      pending.current.add("submit");
      setBusy(true);
      setError(undefined);
      try {
        onStarted(await onLaunch(definition.id, input));
      } catch (failure) {
        setError(String(failure));
      } finally {
        pending.current.delete("submit");
        setBusy(false);
      }
    },
    [definition.id, onLaunch, onStarted, quitting]
  );
  const cancel = useCallback(() => {
    if (!quitting) {
      onCancel();
    }
  }, [onCancel, quitting]);
  const cancelQuit = useCallback(() => setQuitting(false), []);
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      if (!key.repeated) {
        if (quitting) {
          onClose();
        } else {
          setQuitting(true);
        }
      }
    }
    if (problem && key.name === "escape" && !quitting) {
      onCancel();
    }
  });
  return (
    <SetupFlow
      overlay={
        quitting && (
          <QuitDialog
            onCancel={cancelQuit}
            onConfirm={onClose}
            preview={false}
          />
        )
      }
      title={`Launch ${definition.name}`}
    >
      <text>{definition.description}</text>
      {problem ? (
        <box flexDirection="column">
          <text>{problem}</text>
          <Action
            id="launch:back"
            label="Esc · Back to catalog"
            onAction={cancel}
            value="back"
          />
        </box>
      ) : (
        <ArgumentForm
          active={!quitting}
          busy={busy}
          error={error}
          fields={fields ?? []}
          onCancel={onCancel}
          onSubmit={submit}
        />
      )}
    </SetupFlow>
  );
}
