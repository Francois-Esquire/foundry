import { useKeyboard } from "@opentui/react";
import { useCallback, useRef, useState } from "react";
import { Action } from "~/components/action";
import { ArgumentForm } from "~/components/blocks/argument-form";
import { QuitDialog } from "~/components/blocks/quit-dialog";
import { Select } from "~/components/ui/select";
import { SetupFlow, SetupStep } from "~/components/ui/setup-flow";
import { useTheme } from "~/hooks/use-theme";
import type { InputField, InputValues } from "~/lib/inputs";
import {
  renderConfig,
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
  const theme = useTheme();
  const [draft, setDraft] = useState<SetupDraft>({
    harness: "auto",
    instructions: "",
    name: "summarize-codebase",
    template: "product",
  });
  const [stage, setStage] = useState<"template" | "settings" | "review">(
    "template"
  );
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const pending = useRef(new Set<string>());
  const [quitting, setQuitting] = useState(false);
  const starter =
    STARTERS.find((item) => item.id === draft.template) ?? STARTERS[2];
  const create = useCallback(async () => {
    if (pending.current.has("submit") || quitting) {
      return;
    }
    pending.current.add("submit");
    setBusy(true);
    setError(undefined);
    try {
      await onCreate(draft);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      pending.current.delete("submit");
      setBusy(false);
    }
  }, [draft, onCreate, quitting]);
  const back = useCallback(() => {
    if (quitting || pending.current.has("submit")) {
      return;
    }
    setError(undefined);
    setStage(stage === "review" ? "settings" : "template");
  }, [stage, quitting]);
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
  const cancelQuit = useCallback(() => setQuitting(false), []);
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
        renderConfig(configured);
        setDraft(configured);
        setError(undefined);
        setStage("review");
      } catch (failure) {
        setError(String(failure));
      }
    },
    [draft]
  );
  const goBack = stage === "template" ? skip : back;
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      if (key.repeated) {
        return;
      }
      if (quitting) {
        onClose();
      } else {
        setQuitting(true);
      }
      return;
    }
    if (quitting || busy || stage === "settings") {
      return;
    }
    if (key.name === "q") {
      setQuitting(true);
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
            onCancel={cancelQuit}
            onConfirm={onClose}
            preview={false}
          />
        )
      }
      title="Set up your workspace"
    >
      <text fg={theme.colors.mutedForeground}>No config found · {path}</text>
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
          error={error}
          fields={SETTINGS}
          initialValues={{
            harness: draft.harness,
            instructions: draft.instructions,
            name: draft.name,
          }}
          key={draft.template}
          onCancel={back}
          onSubmit={review}
          submitLabel="Review config"
        />
      )}
      <SetupStep status={stepStatus(stage, "review")}>
        Review and create config
      </SetupStep>
      {stage === "review" && (
        <box flexDirection="column" gap={1}>
          <text fg={theme.colors.foreground}>{renderConfig(draft)}</text>
          <text fg={theme.colors.mutedForeground}>
            One step · no workflows or triggers · nothing runs during setup
          </text>
          {error && <text fg={theme.colors.error}>{error}</text>}
          <Action
            active
            id="setup:create"
            label={busy ? "Creating config..." : "Enter · Create config"}
            onAction={create}
            value="create"
          />
          {!busy && (
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
