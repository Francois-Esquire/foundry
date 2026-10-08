import { useMutation, useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon, Loader2Icon } from "lucide-react";
import { useCallback, useState } from "react";
import { worksApi } from "~/app/api/client";
import { SectionCard, SectionHeader } from "~/app/components/settings";
import { TabBar } from "~/app/components/tab-bar";
import {
  type FieldState,
  type VaultGroup,
  type VaultOwner,
  type VaultOwnerId,
  type VaultStatus,
  vaultOwnersIn,
} from "~/shared/vault";
import { CredentialField } from "./credential-field";

const UNSET: FieldState = { isSet: false, source: "none" };

export interface VaultSectionProps {
  description: string;
  group: VaultGroup;
  id: string;
  title: string;
}

/**
 * One group of the vault as a tabbed card: a tab per owner, the active owner's
 * fields below. Status comes from the main process over RPC; saves and clears
 * go back the same way. The watch stream pushes status after each change.
 */
export function VaultSection({
  description,
  group,
  id,
  title,
}: VaultSectionProps) {
  const owners = vaultOwnersIn(group);
  const [activeId, setActiveId] = useState<VaultOwnerId | undefined>(
    owners[0]?.id
  );
  const active = owners.find((owner) => owner.id === activeId) ?? owners[0];

  const api = worksApi();
  const status = useQuery(api.vault.watch.experimental_liveOptions());
  const setField = useMutation(api.vault.set.mutationOptions());
  const clearField = useMutation(api.vault.clear.mutationOptions());

  const { mutate: save } = setField;
  const { mutate: clear } = clearField;
  const activeOwnerId = active?.id;

  const handleSave = useCallback(
    (key: string, value: string) => {
      if (activeOwnerId) {
        save({ key, owner: activeOwnerId, value });
      }
    },
    [activeOwnerId, save]
  );

  const handleClear = useCallback(
    (key: string) => {
      if (activeOwnerId) {
        clear({ key, owner: activeOwnerId });
      }
    },
    [activeOwnerId, clear]
  );

  if (!active) {
    return null;
  }

  const mutationError = setField.error ?? clearField.error;

  return (
    <section aria-labelledby={id}>
      <SectionHeader id={id} title={title} />
      <p className="mb-4 max-w-[65ch] text-muted-foreground text-sm leading-relaxed">
        {description}
      </p>
      <SectionCard className="divide-y-0 p-4">
        <TabBar
          onChange={setActiveId}
          tabs={owners.map((owner) => ({ id: owner.id, label: owner.label }))}
          value={active.id}
        />
        <div className="mt-4 space-y-4">
          <VaultFields
            onClear={handleClear}
            onSave={handleSave}
            owner={active}
            status={status.data}
            statusError={status.error}
          />
          {mutationError ? (
            <p className="text-destructive text-xs" role="alert">
              {mutationError.message}
            </p>
          ) : null}
          {active.docsUrl ? (
            <a
              className="inline-flex items-center gap-1 text-muted-foreground text-xs transition-colors hover:text-foreground"
              href={active.docsUrl}
              rel="noreferrer"
              target="_blank"
            >
              {active.label} docs
              <ExternalLinkIcon className="size-3" />
            </a>
          ) : null}
        </div>
      </SectionCard>
    </section>
  );
}

function VaultFields({
  onClear,
  onSave,
  owner,
  status,
  statusError,
}: {
  onClear: (key: string) => void;
  onSave: (key: string, value: string) => void;
  owner: VaultOwner;
  status: VaultStatus | undefined;
  statusError: Error | null;
}) {
  if (statusError) {
    return (
      <p className="text-destructive text-xs" role="alert">
        The vault could not be reached: {statusError.message}
      </p>
    );
  }
  if (!status) {
    return (
      <p
        aria-busy="true"
        className="flex items-center gap-2 text-muted-foreground text-xs"
      >
        <Loader2Icon className="size-3 animate-spin" />
        Reading vault status
      </p>
    );
  }
  const states = status.fields[owner.id];
  return (
    <>
      {status.encryption === "unavailable" ? (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-700 text-xs dark:text-amber-300">
          OS-level encryption is unavailable, so stored secrets cannot be read
          or written on this device.
        </p>
      ) : null}
      {owner.fields.map((field) => (
        <CredentialField
          field={field}
          key={field.key}
          onClear={onClear}
          onSave={onSave}
          state={states[field.key] ?? UNSET}
        />
      ))}
    </>
  );
}
