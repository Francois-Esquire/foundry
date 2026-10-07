import { Dialog } from "~/components/ui/dialog";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";

export function QuitDialog({
  onCancel,
  onConfirm,
  preview,
}: {
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
      <Text>Quitting stops schedules and monitoring for this session.</Text>
      <Text>
        Saved results and successful monitor checkpoints are kept for the next
        launch.
      </Text>
      <text fg={theme.colors.warning}>
        Running steps are cancelled. Runs waiting on an answer, or paused, are
        kept and resume on the next launch.
      </text>
      {preview && (
        <text fg={theme.colors.mutedForeground}>
          Preview only: closing this view does not stop any real work.
        </text>
      )}
    </Dialog>
  );
}
