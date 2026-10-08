import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { findVaultField, VAULT_OWNER_IDS } from "~/shared/vault";
import { base } from "./context";
import { watchVault } from "./watch-vault";

const FieldRef = z.object({
  key: z.string().min(1),
  owner: z.enum(VAULT_OWNER_IDS),
});

function assertKnownField(owner: string, key: string): void {
  if (!findVaultField(owner, key)) {
    throw new ORPCError("BAD_REQUEST", {
      message: `${owner} has no field named ${key}`,
    });
  }
}

export const vaultRouter = {
  clear: base.input(FieldRef).handler(async ({ context, input }) => {
    assertKnownField(input.owner, input.key);
    await context.vault.set(input.owner, input.key, null);
  }),

  set: base
    .input(FieldRef.extend({ value: z.string() }))
    .handler(async ({ context, input }) => {
      assertKnownField(input.owner, input.key);
      await context.vault.set(input.owner, input.key, input.value);
    }),

  /** Presence and source per field. Never the values. */
  status: base.handler(({ context }) => context.vault.status()),

  /** A fresh snapshot on every connection, then presence/source changes. */
  watch: base.handler(({ context, signal }) =>
    watchVault(context.vault, signal)
  ),
};
