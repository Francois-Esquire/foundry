import type { InstallationId } from "../domain";

export function settledTransitionNotifier(
  observer: ((installationId: InstallationId) => void) | undefined
): (installationId: InstallationId) => void {
  return (installationId) => {
    try {
      observer?.(installationId);
    } catch (error) {
      console.error(
        `[modules] settled-transition observer failed for ${installationId}:`,
        error
      );
    }
  };
}
