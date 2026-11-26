import type { KeyEvent } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import {
  type ReactNode,
  useCallback,
  useEffectEvent,
  useLayoutEffect,
} from "react";
import { QuitDialog } from "~/components/blocks/quit-dialog";
import { IntroActions, IntroDetails } from "~/components/blocks/setup-intro";
import { SetupFlow } from "~/components/layouts/setup-flow";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";
import { useAsyncAction } from "~/tui/hooks/use-async-action";
import { useQuitGuard } from "~/tui/hooks/use-quit-guard";
import type { discoverProviderSetup } from "~/workspace/provider-setup";

type ProviderReview = Pick<
  Awaited<ReturnType<typeof discoverProviderSetup>>,
  "configured" | "offered" | "reserved"
>;

function Intro({
  title,
  primary,
  workspace,
  children,
  onContinue,
  onSkip,
  onClose,
}: {
  readonly title: string;
  readonly primary: string;
  readonly workspace: string;
  readonly children: ReactNode;
  readonly onContinue: () => Promise<void>;
  readonly onSkip?: () => Promise<void>;
  readonly onClose: () => void;
}) {
  const action = useAsyncAction();
  const quit = useQuitGuard(onClose);
  const act = useCallback(
    (work: () => Promise<void>) => {
      if (!(action.busy || quit.quitting)) {
        action.run(work);
      }
    },
    [action.busy, action.run, quit.quitting]
  );
  const proceed = useCallback(() => act(onContinue), [act, onContinue]);
  const skip = useCallback(() => {
    if (onSkip) {
      act(onSkip);
    }
  }, [act, onSkip]);
  const { keyInput } = useRenderer();
  const handleKey = useEffectEvent((key: KeyEvent) => {
    if (quit.handleKey(key) || action.busy) {
      return;
    }
    switch (key.name) {
      case "enter":
      case "return":
        proceed();
        break;
      case "escape":
        skip();
        break;
      case "q":
        quit.ask();
        break;
      default:
        break;
    }
  });
  useLayoutEffect(() => {
    keyInput.on("keypress", handleKey);
    return () => {
      keyInput.off("keypress", handleKey);
    };
  }, [keyInput]);
  return (
    <SetupFlow
      footer={
        <IntroActions
          busy={action.busy}
          onContinue={proceed}
          onSkip={onSkip ? skip : undefined}
          primary={primary}
        />
      }
      maxHeight={15}
      overlay={
        quit.quitting && (
          <QuitDialog onCancel={quit.cancel} onConfirm={onClose} />
        )
      }
      title={title}
    >
      <IntroDetails error={action.error} workspace={workspace}>
        {children}
      </IntroDetails>
    </SetupFlow>
  );
}

export function ProviderOnboarding({
  review,
  workspace,
  onContinue,
  onClose,
}: {
  readonly review: ProviderReview;
  readonly workspace: string;
  readonly onContinue: (useDetected: boolean) => Promise<void>;
  readonly onClose: () => void;
}) {
  const canSave = !review.configured && review.offered.length > 0;
  const continueSetup = useCallback(
    () => onContinue(canSave),
    [canSave, onContinue]
  );
  const skip = useCallback(() => onContinue(false), [onContinue]);
  return (
    <Intro
      onClose={onClose}
      onContinue={continueSetup}
      onSkip={canSave ? skip : undefined}
      primary={canSave ? "Enter · Use detected providers" : "Enter · Continue"}
      title="Set up model providers"
      workspace={workspace}
    >
      {review.configured && (
        <Text>
          Providers are already configured. Your settings will be kept.
        </Text>
      )}
      {review.offered.length > 0 && (
        <box flexDirection="column">
          <Text>Detected on this machine</Text>
          {review.offered.map(({ id, label }) => (
            <text fg={theme.colors.accent} key={id}>
              {label ?? id}
            </text>
          ))}
        </box>
      )}
      {review.reserved.map(({ id, taken }) => (
        <Text key={id} wrapMode="word">
          {id} is assigned to workspace {taken}.
        </Text>
      ))}
      {canSave && <Text>Use these providers for all workspaces.</Text>}
      {!review.configured && review.offered.length === 0 && (
        <Text wrapMode="word">
          No machine-wide providers are available. You can set up your workspace
          now and recheck providers later.
        </Text>
      )}
    </Intro>
  );
}

export function WorkspaceWelcome({
  path,
  workspace,
  onContinue,
  onClose,
}: {
  readonly path: string;
  readonly workspace: string;
  readonly onContinue: () => Promise<void>;
  readonly onClose: () => void;
}) {
  return (
    <Intro
      onClose={onClose}
      onContinue={onContinue}
      primary="Enter · Load Marbles"
      title="Open this workspace"
      workspace={workspace}
    >
      <box flexDirection="column">
        <Text>Existing Marbles source</Text>
        <text fg={theme.colors.mutedForeground} wrapMode="word">
          {path}
        </text>
      </box>
      <Text wrapMode="word">
        Marbles will load your workflows and schedules from this source.
      </Text>
    </Intro>
  );
}
