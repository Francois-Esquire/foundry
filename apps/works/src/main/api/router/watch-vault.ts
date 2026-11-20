import { AsyncIteratorClass, EventPublisher } from "@orpc/server";
import type { Vault } from "~/main/vault/vault";
import type { VaultStatus } from "~/shared/vault";

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
