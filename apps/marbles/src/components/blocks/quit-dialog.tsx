import { Dialog } from "~/components/ui/dialog";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";

/** Quitting a hosted workspace detaches: the Marbles process keeps it going. */
function HostedNotice() {
  return (
    <>
      <Text>
        Quitting closes this dashboard. Triggers keep running in the Marbles
        process, and running steps continue there.
      </Text>
      <Text>
        Open marbles again to watch them; marbles stop ends the process and
        every workspace it hosts.
      </Text>
    </>
  );
}

function SessionNotice() {
  return (
    <>
      <Text>Quitting stops schedules and monitoring for this session.</Text>
      <Text>
        Saved results and successful monitor checkpoints are kept for the next
        launch.
      </Text>
      <text fg={theme.colors.warning}>
        Running steps are cancelled. Runs waiting on an answer, or paused, are
        kept and resume on the next launch.
      </text>
    </>
  );
}

export function QuitDialog({
  hosted = false,
  onCancel,
  onConfirm,
  preview,
}: {
  /** The workspace runs in the Marbles process, not in this one. */
  readonly hosted?: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly preview: boolean;
}) {
  return (
    <Dialog
      cancelLabel="Keep open"
      confirmLabel="Quit"
      hint="Tab choose · Enter select · Esc back · Ctrl+C quit"
      onCancel={onCancel}
      onConfirm={onConfirm}
      title="Quit Marbles?"
      variant="danger"
    >
      {hosted ? <HostedNotice /> : <SessionNotice />}
      {preview && (
        <text fg={theme.colors.mutedForeground}>
          Preview only: closing this view does not stop any real work.
        </text>
      )}
    </Dialog>
  );
}
