import { dirname } from "node:path";
import { useKeyboard } from "@opentui/react";
import { useCallback, useState } from "react";
import { ArgumentForm } from "~/components/blocks/argument-form";
import { QuitDialog } from "~/components/blocks/quit-dialog";
import { SetupFlow } from "~/components/layouts/setup-flow";
import { Action } from "~/components/ui/action";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";
import {
  type InputField,
  type InputValues,
  inputProblem,
  parseInputs,
} from "~/lib/definitions/inputs";
import { errorMessage, useAsyncAction } from "~/tui/hooks/use-async-action";
import { useQuitGuard } from "~/tui/hooks/use-quit-guard";
import {
  DEFAULT_DRAFT,
  renderModule,
  type SetupDraft,
  STARTER_GUIDE,
} from "~/workspace/templates";

const SETTINGS: readonly InputField[] = [
  { label: "Step name", name: "name", required: true, type: "text" },
  { label: "Additional instructions", name: "instructions", type: "multiline" },
];
const SETTINGS_PROBLEM = inputProblem(SETTINGS);
const parseSettings = (values: InputValues) => parseInputs(SETTINGS, values);
const STAGES = {
  review: { height: 34, title: "Review and create module" },
  settings: { height: 25, title: "Configure your first step" },
} as const;

export function OnboardingView({
  path,
  workspace = dirname(path),
  onCreate,
  onSkip,
  onClose,
}: {
  readonly path: string;
  readonly workspace?: string;
  readonly onCreate: (draft: SetupDraft) => Promise<void>;
  readonly onSkip: () => void;
  readonly onClose: () => void;
}) {
  const [draft, setDraft] = useState<SetupDraft>(DEFAULT_DRAFT);
  const [stage, setStage] = useState<"settings" | "review">("settings");
  const [invalid, setInvalid] = useState<string>();
  const creation = useAsyncAction();
  const quit = useQuitGuard(onClose);
  const { quitting } = quit;
  const create = useCallback(() => {
    if (!quitting) {
      creation.run(() => onCreate(draft));
    }
  }, [draft, onCreate, quitting, creation.run]);
  const back = useCallback(() => {
    if (quitting || creation.busy) {
      return;
    }
    setInvalid(undefined);
    creation.clear();
    setStage("settings");
  }, [quitting, creation.busy, creation.clear]);
  const skip = useCallback(() => {
    if (!quitting) {
      onSkip();
    }
  }, [quitting, onSkip]);
  const review = useCallback(
    (values: InputValues) => {
      const configured: SetupDraft = {
        ...draft,
        instructions: String(values.instructions ?? ""),
        name: String(values.name ?? ""),
      };
      try {
        renderModule(configured);
        setDraft(configured);
        setInvalid(undefined);
        setStage("review");
      } catch (failure) {
        setInvalid(errorMessage(failure));
      }
    },
    [draft]
  );
  useKeyboard((key) => {
    if (quit.handleKey(key) || creation.busy || stage === "settings") {
      return;
    }
    if (key.name === "q") {
      quit.ask();
    }
    if (key.name === "escape") {
      back();
    }
    if (["return", "enter"].includes(key.name)) {
      key.preventDefault();
      create();
    }
  });
  return (
    <SetupFlow
      footer={
        <box flexDirection="row" flexWrap="wrap" gap={2}>
          {stage === "review" &&
            (creation.busy ? (
              <Text>Creating module…</Text>
            ) : (
              <>
                <Action
                  active
                  id="setup:create"
                  label="Enter · Create module"
                  onAction={create}
                  value="create"
                />
                <Action
                  id="setup:back"
                  label="Esc · Back"
                  onAction={back}
                  value="back"
                />
              </>
            ))}
        </box>
      }
      maxHeight={STAGES[stage].height}
      overlay={
        quitting && <QuitDialog onCancel={quit.cancel} onConfirm={onClose} />
      }
      title="Set up your workspace"
    >
      <box flexDirection="column" gap={1} marginTop={1}>
        <text fg={theme.colors.mutedForeground} wrapMode="word">
          {stage === "review"
            ? `Starter location · ${path}`
            : `Workspace · ${workspace}`}
        </text>
        <text fg={theme.colors.primary}>
          <strong>{STAGES[stage].title}</strong>
        </text>
        {stage === "settings" && (
          <ArgumentForm
            active={!quitting}
            error={invalid}
            fields={SETTINGS}
            initialValues={{
              instructions: draft.instructions,
              name: draft.name,
            }}
            onCancel={skip}
            onSubmit={review}
            parse={parseSettings}
            problem={SETTINGS_PROBLEM}
            submitLabel="Review module"
          />
        )}
        {stage === "review" && (
          <box flexDirection="column" gap={1}>
            <Text>{renderModule(draft)}</Text>
            <text fg={theme.colors.mutedForeground}>
              Creates one starter step. You can run it from the Catalog.
            </text>
            <text fg={theme.colors.mutedForeground} wrapMode="word">
              {`Guide · ${STARTER_GUIDE}`}
            </text>
            {creation.error && (
              <text fg={theme.colors.error}>{creation.error}</text>
            )}
          </box>
        )}
      </box>
    </SetupFlow>
  );
}
