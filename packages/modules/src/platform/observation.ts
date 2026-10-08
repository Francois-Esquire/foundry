import type { InstallationId } from "../domain";

/**
 * Fail-soft settled-transition observation, shared by management and the
 * Program supervisor: the observer can neither delay nor roll back a
 * committed Module transition.
 */
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
