import { type Consumption, mergeConsumption } from "./consumption";
import type { Limit, Window } from "./limit";
import type { Account } from "./usage";

/**
 * What only one provider reports, keyed by provider id. Each provider adds
 * its own optional member by declaration merging:
 *
 * ```ts
 * declare module "@foundry/usage" {
 *   interface ProviderDetails {
 *     readonly anthropic?: AnthropicDetails;
 *   }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: providers add members by declaration merging.
export interface ProviderDetails {}

/** The provider's own identity for an account, learned from a reading. */
export interface AccountIdentity {
  readonly email?: string;
  readonly id: string;
  readonly plan?: string;
}

/** What a provider reported about one account's limits when asked. */
export interface Reading {
  readonly account?: AccountIdentity;
  readonly details?: ProviderDetails;
  readonly limits: readonly Limit[];
  /** Set when this credential never has limits. */
  readonly unsupported?: string;
}

/** One account in a snapshot: its reading and its consumption. */
export interface AccountUsage {
  readonly account?: AccountIdentity;
  readonly consumption?: Consumption;
  /** This query could not read the consumption; the limits may still be read. */
  readonly consumptionFailed?: string;
  readonly details?: ProviderDetails;
  /** This query could not read the limits; the consumption may still be read. */
  readonly failed?: string;
  readonly limits: readonly Limit[];
  readonly provider: string;
  readonly readAt?: Date;
  readonly unsupported?: string;
  window(id: string): Window | undefined;
}

/** One query's answer: every account at one moment, each account once. */
export interface Snapshot {
  readonly accounts: readonly AccountUsage[];
  readonly at: Date;
  of(account: Account): AccountUsage | undefined;
}

/** What one query learned through one added account's credential. */
export interface AccountRead {
  readonly account: Account;
  readonly consumption?: Consumption;
  readonly consumptionFailed?: string;
  readonly failed?: string;
  readonly readAt: Date;
  readonly reading?: Reading;
}

type AccountUsageFields = Omit<AccountUsage, "window">;

const accountUsage = (fields: AccountUsageFields): AccountUsage => ({
  ...fields,
  window: (id) =>
    fields.limits.find(
      (limit): limit is Window => limit.kind === "window" && limit.id === id
    ),
});

const fieldsOf = (read: AccountRead): AccountUsageFields => {
  const { account, consumption, consumptionFailed, failed, readAt, reading } =
    read;
  return {
    account: reading?.account,
    consumption,
    consumptionFailed,
    details: reading?.details,
    failed,
    limits: reading?.limits ?? [],
    provider: account.credential.provider,
    readAt: reading ? readAt : undefined,
    unsupported: reading?.unsupported,
  };
};

/** Known only from a reading, so a read whose limits failed stands alone. */
const identityOf = (read: AccountRead): string | undefined => {
  const id = read.reading?.account?.id;
  return id === undefined
    ? undefined
    : JSON.stringify([read.account.credential.provider, id]);
};

/**
 * Builds a snapshot from one query's reads. Reads that reach the same
 * provider account id become one account: the first read's reading, and
 * the consumption of all of them.
 */
export const buildSnapshot = (
  reads: readonly AccountRead[],
  at: Date
): Snapshot => {
  const fields: AccountUsageFields[] = [];
  const indexByIdentity = new Map<string, number>();
  const indexByAccount = new Map<Account, number>();

  for (const read of reads) {
    const identity = identityOf(read);
    const existing =
      identity === undefined ? undefined : indexByIdentity.get(identity);
    const current = existing === undefined ? undefined : fields[existing];
    if (existing !== undefined && current) {
      const consumption = mergeConsumption(
        current.consumption,
        read.consumption
      );
      const consumptionFailed =
        current.consumptionFailed ?? read.consumptionFailed;
      fields[existing] = { ...current, consumption, consumptionFailed };
      indexByAccount.set(read.account, existing);
      continue;
    }
    if (identity !== undefined) {
      indexByIdentity.set(identity, fields.length);
    }
    indexByAccount.set(read.account, fields.length);
    fields.push(fieldsOf(read));
  }

  const accounts = fields.map(accountUsage);
  return {
    accounts,
    at,
    of: (account) => {
      const index = indexByAccount.get(account);
      return index === undefined ? undefined : accounts[index];
    },
  };
};
