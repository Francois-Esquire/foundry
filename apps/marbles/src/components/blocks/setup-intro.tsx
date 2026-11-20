import type { ReactNode } from "react";
import { Action } from "~/components/ui/action";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";

export function IntroDetails({
  workspace,
  error,
  children,
}: {
  readonly workspace: string;
  readonly error?: string;
  readonly children: ReactNode;
}) {
  return (
    <box flexDirection="column" gap={1} marginTop={1}>
      <text fg={theme.colors.mutedForeground} wrapMode="word">
        Workspace · {workspace}
      </text>
      {children}
      {error && (
        <text fg={theme.colors.error} wrapMode="word">
          {error}
        </text>
      )}
    </box>
  );
}

export function IntroActions({
  busy,
  primary,
  onContinue,
  onSkip,
}: {
  readonly busy: boolean;
  readonly primary: string;
  readonly onContinue: () => void;
  readonly onSkip?: () => void;
}) {
  return (
    <box flexDirection="row" flexWrap="wrap" gap={2}>
      {busy ? (
        <Text>Saving…</Text>
      ) : (
        <>
          <Action
            active
            label={primary}
            onAction={onContinue}
            value="continue"
          />
          {onSkip && (
            <Action label="Esc · Skip" onAction={onSkip} value="skip" />
          )}
        </>
      )}
    </box>
  );
}
