import { VignettePage } from "~/app/layout/page-vignette";
import { VaultSection } from "./settings/vault-section";

export function SettingsPage() {
  return (
    <VignettePage
      viewportClassName="relative min-h-full"
      vignette={{ edgeStrength: 0 }}
    >
      <div className="shrink-0 px-8 pt-10 pb-8">
        <h1 className="m-0 min-w-0 font-sans font-semibold text-[clamp(1.75rem,2.5vw+0.5rem,2.5rem)] text-foreground leading-[1.06] tracking-[-0.03em]">
          Settings
        </h1>
      </div>

      <div className="px-8 pb-12">
        <div className="mx-auto max-w-xl space-y-10">
          <VaultSection
            description="Bring your own key for each provider. Keys are encrypted on this device, and a matching environment variable is used when no key is set."
            group="provider"
            id="settings-providers"
            title="Providers"
          />
          <VaultSection
            description="Connect external services that tools call. Stored the same way as provider keys."
            group="integration"
            id="settings-integrations"
            title="Integrations"
          />
        </div>
      </div>
    </VignettePage>
  );
}
