import type { ChromeContext } from "./chrome-entries";
import { DeveloperSettingsSection } from "./developer-settings";

/** Imported only in development; production builds have no tools chunk. */
export function DeveloperStats({ actions }: ChromeContext) {
  return (
    <div className="spyglass-chart-settings spyglass-development-tools">
      <DeveloperSettingsSection scene={actions.scene} />
    </div>
  );
}
