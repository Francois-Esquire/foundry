# @foundry/usage

What an AI provider lets an account consume, and what that consumption
costs, as it is at the moment you ask. A Claude Max login has two windows,
five-hour and weekly, each seen only as a share used; a ChatGPT Pro login
has one, weekly. An API key is billed per use in money. A prepaid balance
drains until it is topped up, and Codex credits drain in a unit OpenAI
prices. This package describes all of them in one model, so a caller asks
"how much headroom does this account have, and when does it come back?" the
same way for each. The glossary is `CONTEXT.md`.

It observes and reports. It keeps nothing: there is no store, no cache, and
no record of its own. Nothing here limits work, blocks it, or acts on a
value; a caller that wants to branch on usage queries it and branches.

Status: the model only. There is no source yet. The snippets below show
the mechanics the code will follow, not its final surface.

## Mechanics

There is one `usage`, already created. The package entry registers the
built-in providers, Anthropic and OpenAI, and nothing else happens on
import: no account is added and no provider is asked anything. A provider
of your own is registered with one call:

```ts
usage.use(myProvider);
```

### Adding accounts

A caller adds accounts by credential, and gets each account back. `detect()`
adds the ones this machine already has: the default Claude Code and Codex
logins, and any provider API keys in the environment. It finds credentials
only; it asks no provider anything.

```ts
import { usage } from "@foundry/usage";
import { anthropic } from "@foundry/usage/providers/anthropic";
import { openai } from "@foundry/usage/providers/openai";

await usage.detect(); // the default logins and keys

const work = usage.add(anthropic.login({ configDir: "~/.claude-work" }));
const personal = usage.add(openai.login({ home: "~/.codex-personal" }));
```

A credential is only how a query reaches an account. Claude Code is pointed
at `configDir` the way `CLAUDE_CONFIG_DIR` points it, and Codex at `home`
the way `CODEX_HOME` does. The provider's own account id is learned when the
account is first queried. Two credentials that reach the same account show
up as one account.

### Querying

A query is the only way usage is known. It asks each account's provider for
its limits and reads each account's consumption from the history its client
already keeps, then returns a snapshot. Nothing from one query is kept for
the next.

```ts
const snapshot = await usage.query(); // every account, now
const lastWeek = await usage.query({ since: "7d" }); // consumption over the last week
const justWork = await usage.query({ accounts: [work] });
```

Asking providers takes a second or more, so a query is slow next to a value
in memory. The caller decides how often to ask.

A workflow step that waits out a weekly window:

```ts
const snapshot = await usage.query({ accounts: [work] });
const weekly = snapshot.of(work)?.window("weekly-window");

if (weekly && headroom(weekly).share < 0.1) {
  return { deferUntil: weekly.resetsAt };
}
```

A dashboard holds the last snapshot in its own state, renders from that,
and queries beside the render, never inside it:

```ts
let latest = await usage.query();
setInterval(async () => {
  latest = await usage.query();
}, 60_000);
render(latest);
```

### Consumption comes from history

Claude Code and Codex already write every session to disk under their
config directories, with token counts on each response. That history is
where consumption comes from. The credential that routes a query to an
account's limits routes it to that account's history too, so work done
outside Foundry is counted as well.

Consumption is reported per account and per session. The package does not
know what a session was for. A caller that does, such as Foundry knowing
which run and workflow started each session, groups by session itself.

An API key has no local history. Its consumption is unavailable until a
provider's billing API is read.

### When things happened

| Time | Means | Set by |
|---|---|---|
| `snapshot.at` | when the query finished | the package |
| `account.readAt` | when the account's limits were true | stamped before asking the provider |
| `limit.resetsAt` | when the capacity comes back | the provider |
| `consumption.since` to `snapshot.at` | the span consumption covers | the caller, and the query |

A read that fails is reported in that snapshot, with no limits for that
account. The next query asks again.

## The model

Four billing models cover the accounts Foundry works with. Each has one
kind of limit:

| Billing model | Limit | Unit | Comes back | One piece of work |
|---|---|---|---|---|
| Allowance | window | percent of a span of time | when the window ends | has no price in the window; its charge is notional |
| Metered | spend cap | money | each billing period | is priced in money, and is spend |
| Prepaid | balance | money | when topped up | is priced in money, draws the balance down, and is spend |
| Credits | credit balance | the provider's credits | when topped up; credits can expire | costs what the provider says in credits, and is not spend |

Prepaid and credits differ in the unit. Prepaid converts one to one to
money, even when a provider calls it credits. Credits are the provider's
own unit at a rate the provider sets, so their money value is unknown.

Billing models belong to limits, not accounts. A Claude Max account has two
windows and, with extra usage on, a spend cap. A ChatGPT Pro account has one
window and a credit balance. An API key has a spend cap if one is set, and
otherwise no limits at all.

### Building blocks

Everything a query returns is a value, built for that query and dropped
after it.

- **Snapshot** is the root: one query's answer, holding every account at
  one moment.
- **Account** is the one thing with identity: the provider and the
  provider's own account id. Two snapshots describe the same account when
  those match, however it was reached.
- **Credential** is how a query reaches an account. Several can reach one
  account.
- **Reading** is what a provider reported about one account's limits when
  asked.
- **Limit** is one of four kinds: window, spend cap, balance, or credit
  balance. The same questions work on every kind: headroom, time until
  reset, exhausted.
- **Headroom** is what is left of a limit: always an amount in the limit's
  unit, and a share only when the limit has a total. A weekly window at 46%
  has 54 percent and 0.54 left; a balance of $25 has $25 left and no share,
  because nothing says what it was out of.
- **Consumption** is what work used over a span, read from the account's
  history.
- **Charge** is what work cost, and whether that figure was reported,
  priced from list prices, or notional.

The invariants live on these values. A limit's billing model fixes its kind
and its unit. A window's total is 100 percent. Used never exceeds total. A
snapshot holds each account once.

There are no domain events. The package observes; nothing in it reacts.

### Shapes

```ts
type Limit =
  | Window // allowance, percent
  | SpendCap // metered, money
  | Balance // prepaid, money
  | CreditBalance; // credits, the provider's unit

interface Window {
  readonly kind: "window";
  readonly id: string; // "five-hour-window", "weekly-window"
  readonly span: Duration;
  readonly usedPercent: number;
  readonly resetsAt?: Date;
}

interface SpendCap {
  readonly kind: "spend-cap";
  readonly used: Money;
  readonly cap: Money;
  readonly resetsAt?: Date;
}

interface Balance {
  readonly kind: "balance";
  readonly remaining: Money;
}

interface CreditBalance {
  readonly kind: "credit-balance";
  readonly remaining: number;
  readonly expiresAt?: Date;
}

interface Snapshot {
  readonly at: Date;
  readonly accounts: readonly AccountUsage[];
  of(account: Account): AccountUsage | undefined;
}

interface AccountUsage {
  readonly provider: string; // "anthropic", "openai"
  readonly account?: { readonly id: string; readonly email?: string; readonly plan?: string };
  readonly limits: readonly Limit[];
  readonly readAt?: Date;
  readonly failed?: string; // this query could not read the limits
  readonly unsupported?: string; // this credential never has limits
  readonly consumption?: Consumption;
  readonly details?: ProviderDetails;
  window(id: string): Window | undefined;
}

interface Consumption {
  readonly since: Date;
  readonly total: Quantities; // tokens, images, seconds
  readonly charge?: Charge;
  readonly bySession: readonly {
    readonly session: string; // the client's own session id
    readonly model: string;
    readonly quantities: Quantities;
    readonly charge?: Charge;
  }[];
}

interface Charge {
  readonly amount: Money | Credits;
  readonly basis: "reported" | "priced" | "notional";
}

interface Headroom {
  readonly remaining: number; // in the limit's own unit
  readonly unit: "percent" | "usd" | "credits";
  readonly share?: number; // 0 to 1, only when the limit has a total
}

headroom(limit): Headroom;
resetsIn(limit); // time until it comes back, or none if it never resets
exhausted(limit);
```

## Providers

Each provider has its own vocabulary: Claude reports `utilization` per
bucket, Codex reports `primary` and `secondary` rate limits and a credits
balance, an API reports a balance. Both CLIs name their windows by position
or bucket, not span; the provider maps them to the five-hour and weekly
windows. Translating is the provider's job, and nothing provider-shaped
crosses into the model. Each provider is an anti-corruption layer in its own
folder:

```text
src/
  usage.ts                          the shared usage
  limit.ts, consumption.ts, snapshot.ts
  providers/
    anthropic/                      Claude Code logins, API keys
    openai/                         Codex logins, API keys
```

A provider makes credentials, finds the ones a machine has, reads an
account's limits and history through a credential, and, where it can,
prices work:

```ts
interface Provider {
  readonly id: string;
  detect(): Promise<readonly Credential[]>;
  limits(credential: Credential): Promise<Reading>;
  history(credential: Credential, since: Date): Promise<Consumption | undefined>;
  price?(model: string, quantities: Quantities): Charge | undefined;
}
```

Adding a provider means adding a folder. The model does not change. The
core never imports a provider; the package entry imports the built-in ones
and registers them with `usage.use`, which is all a provider of your own
needs too.

### Provider details

What only one provider reports goes in `details`, typed by that provider.
Claude's extra-usage state and its model-scoped weekly window, and Codex's
reset credits and limit-reached reason, live there:

```ts
// providers/anthropic
interface AnthropicDetails {
  readonly extraUsage?: { readonly enabled: boolean; readonly disabledReason?: string };
  readonly modelWindows?: Readonly<Record<string, string>>; // window id → the model it applies to
}

// providers/openai
interface OpenAIDetails {
  readonly limitReached?: string;
  readonly resetCredits?: { readonly available: number; readonly nextExpiresAt?: Date };
}
```

Three rules keep it honest. Details are translated, never the provider's raw
response. Nothing essential lives there; every consumer works without them.
A field moves into the model once a second provider reports it.

## Not here

- Keeping anything: no store, no cache, no record of work. The clients'
  own history is the only record, and this package only reads it.
- Asking in the background. A provider is asked only when a caller queries.
- Limits Foundry sets itself, budgets, or policies.
- Knowing what a session was for. A caller that knows groups by session.
