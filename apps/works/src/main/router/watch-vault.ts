import { AsyncIteratorClass, EventPublisher } from "@orpc/server";
import type { Vault } from "~/main/vault/vault";
import type { VaultStatus } from "~/shared/vault";

/** Current status followed by changes. Each subscriber owns its cleanup. */
export function watchVault(
  vault: Vault,
  signal?: AbortSignal
): AsyncIteratorClass<VaultStatus> {
  const publisher = new EventPublisher<{ status: VaultStatus }>();
  const events = publisher.subscribe("status", { signal });
  const unsubscribe = vault.onChange((status) => {
    publisher.publish("status", status);
  });
  signal?.addEventListener("abort", unsubscribe, { once: true });
  // Subscribe before reading the snapshot so a change cannot fall in between.
  publisher.publish("status", vault.status());

  return new AsyncIteratorClass(
    () => events.next(),
    async () => {
      unsubscribe();
      signal?.removeEventListener("abort", unsubscribe);
      await events.return();
    }
  );
}
