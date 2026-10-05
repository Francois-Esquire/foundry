import { Dialog } from "~/components/ui/dialog";
import { useTheme } from "~/hooks/use-theme";

export function QuitDialog({
  onCancel,
  onConfirm,
  preview,
}: {
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly preview: boolean;
}) {
  const theme = useTheme();
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
      <text fg={theme.colors.foreground}>
        Quitting stops schedules and monitoring for this session.
      </text>
      <text fg={theme.colors.foreground}>
        Saved results and successful monitor checkpoints are kept for the next
        launch.
      </text>
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
