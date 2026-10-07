import { useKeyboard } from "@opentui/react";
import { useCallback, useState } from "react";
import { ArgumentForm } from "~/components/blocks/argument-form";
import { QuitDialog } from "~/components/blocks/quit-dialog";
import { Action } from "~/components/ui/action";
import { Select } from "~/components/ui/select";
import { SetupFlow, SetupStep } from "~/components/ui/setup-flow";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";
import { errorMessage, useAsyncAction } from "~/hooks/use-async-action";
import { useQuitGuard } from "~/hooks/use-quit-guard";
import type { InputField, InputValues } from "~/lib/inputs";
import {
  renderModule,
  type SetupDraft,
  STARTERS,
} from "~/onboarding/templates";

const SETTINGS: readonly InputField[] = [
  { label: "Step name", name: "name", required: true, type: "text" },
  { label: "Additional instructions", name: "instructions", type: "multiline" },
  {
    label: "Harness",
    name: "harness",
    options: [
      { label: "First available", value: "auto" },
      { label: "Codex", value: "codex" },
      { label: "Claude Code", value: "claude-code" },
    ],
    required: true,
    type: "select",
  },
];
const CHOICES = STARTERS.map((item) => ({
  label: `${item.label} · ${item.description}`,
  value: item.id,
}));

function stepStatus(
  current: string,
  target: string
): "active" | "done" | "pending" {
  const stages = ["template", "settings", "review"];
  if (current === target) {
    return "active";
  }
  return stages.indexOf(current) > stages.indexOf(target) ? "done" : "pending";
}

export function OnboardingView({
  path,
  onCreate,
  onSkip,
  onClose,
}: {
  readonly path: string;
  readonly onCreate: (draft: SetupDraft) => Promise<void>;
  readonly onSkip: () => void;
  readonly onClose: () => void;
}) {
  const [draft, setDraft] = useState<SetupDraft>({
    harness: "auto",
    instructions: "",
    name: "summarize-codebase",
    template: "product",
  });
  const [stage, setStage] = useState<"template" | "settings" | "review">(
    "template"
  );
  /** Settings that cannot render into a module. */
  const [invalid, setInvalid] = useState<string>();
  const creation = useAsyncAction();
  const quit = useQuitGuard(onClose);
  const { quitting } = quit;
  const starter =
    STARTERS.find((item) => item.id === draft.template) ?? STARTERS[2];
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
    setStage(stage === "review" ? "settings" : "template");
  }, [stage, quitting, creation.busy, creation.clear]);
  const next = useCallback(() => {
    if (!quitting) {
      setStage("settings");
    }
  }, [quitting]);
  const skip = useCallback(() => {
    if (!quitting) {
      onSkip();
    }
  }, [quitting, onSkip]);
  const chooseTemplate = useCallback(
    (value: string) => {
      if (quitting) {
        return;
      }
      const chosen = STARTERS.find((item) => item.id === value);
      if (chosen) {
        setDraft((previous) => ({
          ...previous,
          name: chosen.name,
          template: chosen.id,
        }));
      }
    },
    [quitting]
  );
  const review = useCallback(
    (values: InputValues) => {
      const harness =
        values.harness === "codex" || values.harness === "claude-code"
          ? values.harness
          : "auto";
      const configured: SetupDraft = {
        ...draft,
        harness,
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
  const goBack = stage === "template" ? skip : back;
  useKeyboard((key) => {
    if (quit.handleKey(key) || creation.busy || stage === "settings") {
      return;
    }
    if (key.name === "q") {
      quit.ask();
    }
    if (key.name === "escape") {
      goBack();
    }
    if (["return", "enter"].includes(key.name)) {
      key.preventDefault();
      if (stage === "template") {
        next();
      } else {
        create();
      }
    }
  });
  return (
    <SetupFlow
      overlay={
        quitting && (
          <QuitDialog
            onCancel={quit.cancel}
            onConfirm={onClose}
            preview={false}
          />
        )
      }
      title="Set up your workspace"
    >
      <text fg={theme.colors.mutedForeground}>
        No authoring folder found · {path}
      </text>
      <SetupStep status={stepStatus(stage, "template")}>
        Choose a starter · {starter.label}
      </SetupStep>
      {stage === "template" && (
        <box flexDirection="column" gap={1}>
          <Select
            focused={!quitting}
            id="setup:template"
            onChange={chooseTemplate}
            options={CHOICES}
            value={draft.template}
          />
          <Action
            active
            id="setup:next"
            label="Enter · Configure step"
            onAction={next}
            value="next"
          />
          <Action
            id="setup:skip"
            label="Esc · Skip for now"
            onAction={skip}
            value="skip"
          />
        </box>
      )}
      <SetupStep status={stepStatus(stage, "settings")}>
        Configure your step
      </SetupStep>
      {stage === "settings" && (
        <ArgumentForm
          active={!quitting}
          error={invalid}
          fields={SETTINGS}
          initialValues={{
            harness: draft.harness,
            instructions: draft.instructions,
            name: draft.name,
          }}
          key={draft.template}
          onCancel={back}
          onSubmit={review}
          submitLabel="Review module"
        />
      )}
      <SetupStep status={stepStatus(stage, "review")}>
        Review and create module
      </SetupStep>
      {stage === "review" && (
        <box flexDirection="column" gap={1}>
          <Text>{renderModule(draft)}</Text>
          <text fg={theme.colors.mutedForeground}>
            One step · no workflows or triggers · nothing runs during setup
          </text>
          {creation.error && (
            <text fg={theme.colors.error}>{creation.error}</text>
          )}
          <Action
            active
            id="setup:create"
            label={
              creation.busy ? "Creating module..." : "Enter · Create module"
            }
            onAction={create}
            value="create"
          />
          {!creation.busy && (
            <Action
              id="setup:back"
              label="Esc · Back"
              onAction={back}
              value="back"
            />
          )}
        </box>
      )}
    </SetupFlow>
  );
}
