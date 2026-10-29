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

Status: built. The core and the Anthropic and OpenAI providers are in
`src/`; every snippet below is the code as it is.

## Mechanics

There is one `usage`, already created. The package entry registers the
built-in providers, `anthropic` and `openai`, and nothing else happens on
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
const key = usage.add(anthropic.apiKey("sk-ant-…")); // reported as unsupported, with no consumption
```

`detect()` decides from presence alone and never reads a secret:

| Provider | Default login | Looks signed in when | API key |
|---|---|---|---|
| `anthropic` | `CLAUDE_CONFIG_DIR`, else `~/.claude` | `.credentials.json` is in it, or its account file is there (`~/.claude.json` for `~/.claude`, `<dir>/.claude.json` otherwise) | `ANTHROPIC_API_KEY` |
| `openai` | `CODEX_HOME`, else `~/.codex` | `auth.json` is in it | `OPENAI_API_KEY` |

A credential is only how a query reaches an account. A login's `id` is its
absolute directory; an API key's `id` is a fingerprint of the key
(`api-key:` and 16 hex characters), never the key. Adding the same
credential twice returns the same account.

Each login reads only its own directory. Claude Code is started with
`CLAUDE_CONFIG_DIR` set to `configDir`, and Codex with `CODEX_HOME` set to
`home`. The one exception is `~/.claude` itself: Claude Code keeps that
login's account file at `~/.claude.json`, and with `CLAUDE_CONFIG_DIR` set
to `~/.claude` it looks inside the directory instead and reads as signed
out, so for it `CLAUDE_CONFIG_DIR` is left unset. An inherited `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, and any
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`,
`OPENAI_API_KEY` or `CODEX_API_KEY`, is removed from the spawned client's
environment, so a key in the environment never stands in for a login.

The provider's own account id is learned when the account is first
queried. Two credentials that reach the same account show up as one
account.

### Querying

A query is the only way usage is known. It asks each account's provider for
its limits and reads each account's consumption from the history its client
already keeps, then returns a snapshot. Nothing from one query is kept for
the next.

```ts
const snapshot = await usage.query(); // every account, all of its history
const lastWeek = await usage.query({ since: "7d" }); // consumption over the last week
const justWork = await usage.query({ accounts: [work] });
const justOpenAI = await usage.query({ provider: "openai" });
```

`since` is a `Date` or a span back from now: a number and `m`, `h`, `d` or
`w`. Without it, consumption covers all history, which on a machine with
months of sessions means gigabytes of transcripts. Files last written
before `since` are skipped unread, so a short span stays fast.

Asking providers takes a second or two: each login read starts its client
(Claude Code takes about 1.8 s, Codex about 1.1 s), and accounts are read in
parallel. A query is slow next to a value in memory, so the caller decides
how often to ask. Claude Code rewrites a login's account file each time it
starts, and keeps a few rotating backups of it under `<configDir>/backups/`;
this package writes nothing itself.

A workflow step that waits out a weekly window:

```ts
import { headroom, usage } from "@foundry/usage";

const snapshot = await usage.query({ accounts: [work], since: "1d" });
const weekly = snapshot.of(work)?.window("weekly-window");

if (weekly && headroom(weekly).share < 0.1) {
  return { deferUntil: weekly.resetsAt };
}
```

A dashboard holds the last snapshot in its own state, renders from that,
and queries beside the render, never inside it:

```ts
let latest = await usage.query({ since: "1d" });
setInterval(async () => {
  latest = await usage.query({ since: "1d" });
}, 60_000);
render(latest);
```

### Consumption comes from history

Claude Code and Codex already write every session to disk under their
config directories, with token counts on each response. That history is
where consumption comes from. The credential that routes a query to an
account's limits routes it to that account's history too, so work done
outside Foundry is counted as well.

Consumption is reported per account, and within it per session and model:
a session that switched models has one entry per model. The package does
not know what a session was for. A caller that does, such as Foundry
knowing which run and workflow started each session, groups by session
itself.

An API key has no local history, so its `consumption` is absent until a
provider's billing API is read.

### Charges

Each piece of work is priced on its own at the model's list price from the
models.dev snapshot bundled in `@foundry/models`, and the prices are summed.
A login's work runs on an allowance, so its charges are `notional`; an API
key's would be `priced`. A model the snapshot does not list exactly, and
work at a fast or priority tier (no tier rates are bundled), has no charge.
A session entry has a charge only when all of its work was priced, and the
total only when every entry has one. Codex credits have no published rate,
so no work is charged in credits.

### When things happened

| Time | Means | Set by |
|---|---|---|
| `snapshot.at` | when the query finished | the package |
| `account.readAt` | when the account's limits were true | stamped before asking the provider; absent when the read failed |
| `limit.resetsAt` | when the capacity comes back | the provider |
| `consumption.since` to `snapshot.at` | the span consumption covers | the caller, and the query |

Limits and consumption are separate reads, and one failing never hides the
other. A limits read that fails sets `failed`, with no limits and no
`readAt`; a history read that fails sets `consumptionFailed`, with no
`consumption`. A signed-out login, a client that does not answer in time
(Claude Code 10 s to start and 5 s to report, Codex 5 s in all), and a
signed-in login that reports no limits all fail. An account whose limits
failed has no provider account id that query, so it stands alone in the
snapshot even when another credential reaches the same account. The next
query asks again.

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

All exported from `@foundry/usage`.

```ts
type Duration = number; // milliseconds

interface Money {
  readonly amount: number;
  readonly unit: "usd";
}

interface Credits {
  readonly amount: number;
  readonly unit: "credits";
}

type Limit =
  | Window // allowance, percent
  | SpendCap // metered, money
  | Balance // prepaid, money
  | CreditBalance; // credits, the provider's unit

interface Window {
  readonly kind: "window";
  readonly id: string; // "five-hour-window", "weekly-window", "weekly-window-fable"
  readonly span: Duration;
  readonly usedPercent: number; // 0 to 100
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
  readonly account?: AccountIdentity;
  readonly limits: readonly Limit[];
  readonly readAt?: Date;
  readonly failed?: string; // this query could not read the limits
  readonly unsupported?: string; // this credential never has limits
  readonly consumption?: Consumption;
  readonly consumptionFailed?: string; // this query could not read the history
  readonly details?: ProviderDetails;
  window(id: string): Window | undefined;
}

interface AccountIdentity {
  readonly id: string; // the provider's own account id
  readonly email?: string;
  readonly plan?: string; // "max", "pro"
}

interface Consumption {
  readonly since: Date;
  readonly total: Quantities;
  readonly charge?: Charge;
  readonly bySession: readonly SessionConsumption[];
}

interface SessionConsumption {
  readonly session: string; // the client's own session id
  readonly model: string; // as the client recorded it, such as "claude-sonnet-4-5"
  readonly quantities: Quantities;
  readonly charge?: Charge;
}

// Input, cached input, cache write and output are disjoint. Reasoning is the
// part of output spent reasoning, so it is not added to output. A zero count
// is left out.
interface Quantities {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly images?: number;
  readonly seconds?: number;
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

function headroom(limit: Window | SpendCap): Required<Headroom>;
function headroom(limit: Limit): Headroom;
function resetsIn(limit: Limit, now?: Date): Duration | undefined; // none if it never resets
function exhausted(limit: Limit): boolean;

interface Usage {
  use(provider: Provider): void;
  add(credential: Credential): Account;
  detect(): Promise<readonly Account[]>;
  query(options?: QueryOptions): Promise<Snapshot>;
}

interface QueryOptions {
  readonly accounts?: readonly Account[];
  readonly provider?: string;
  readonly since?: Date | DurationText; // all history when absent
}

type DurationText = `${number}${"m" | "h" | "d" | "w"}`; // "30m", "7d"

interface Account {
  readonly credential: Credential;
}

const usage: Usage;
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
  index.ts                          the package entry: registers the built-in providers
  usage.ts                          the shared usage
  limit.ts, consumption.ts, snapshot.ts
  providers/
    local.ts, work.ts, values.ts    files and PATH, pricing and totals, reading client output
    anthropic/                      Claude Code logins, API keys
      provider.ts, limits.ts, history.ts
    openai/                         Codex logins, API keys
      provider.ts, limits.ts, history.ts
```

A provider makes credentials, finds the ones a machine has, reads an
account's limits and history through a credential, and, where it can,
prices work. A credential is any object with a `provider` and a stable,
non-secret `id`; a provider adds the fields it routes by.

```ts
interface Credential {
  readonly provider: string; // the provider that reads through it
  readonly id: string; // stable within the provider, never a secret
}

interface Reading {
  readonly account?: AccountIdentity;
  readonly limits: readonly Limit[];
  readonly unsupported?: string;
  readonly details?: ProviderDetails;
}

interface Provider {
  readonly id: string;
  detect(): Promise<readonly Credential[]>;
  limits(credential: Credential): Promise<Reading>; // throw to report `failed`
  history(credential: Credential, since: Date): Promise<Consumption | undefined>; // throw to report `consumptionFailed`
  price?(model: string, quantities: Quantities): Charge | undefined;
}
```

Adding a provider means adding a folder. The model does not change. The
core never calls `price`; a provider puts charges inside the `Consumption`
it returns. The core never imports a provider either; the package entry
imports the built-in ones and registers them with `usage.use`, which is all
a provider of your own needs too.

### Anthropic

```ts
import { anthropic } from "@foundry/usage/providers/anthropic";

interface AnthropicLogin extends Credential {
  readonly provider: "anthropic";
  readonly kind: "login";
  readonly configDir: string; // absolute
}

interface AnthropicApiKey extends Credential {
  readonly provider: "anthropic";
  readonly kind: "api-key";
  readonly key: string;
}

type AnthropicCredential = AnthropicLogin | AnthropicApiKey;

interface AnthropicProvider extends Provider {
  readonly id: "anthropic";
  login(options?: { readonly configDir?: string }): AnthropicLogin; // "~" allowed
  apiKey(key: string): AnthropicApiKey;
  detect(): Promise<readonly AnthropicCredential[]>;
  price(model: string, quantities: Quantities): Charge | undefined; // basis "priced"
}
```

Limits come from Claude Code itself: the `claude` on `PATH` (the Agent
SDK's bundled CLI when there is none) is started through the Agent SDK with
a prompt that never yields, so nothing reaches the model, and asked for its
account and then `/usage`. It loads no settings, hooks, tools or MCP
servers, keeps no transcript, and is closed on every path.

| Claude reports | Becomes |
|---|---|
| `five_hour` | window `five-hour-window`, 5 hours |
| `seven_day` | window `weekly-window`, 7 days |
| each `model_scoped` entry, such as Fable | window `weekly-window-fable`, 7 days; `details.anthropic.modelWindows` names the model |
| `spend` or `extra_usage`, while enabled and in USD | a spend cap in dollars |
| `extra_usage` on or off, and why | `details.anthropic.extraUsage` |
| account email, `subscription_type` | `account`: `id` is the email lowercased, `plan` such as `max` |
| an API key, a cloud provider, or `rate_limits_available: false` | `unsupported` |

Consumption comes from the session transcripts under
`<configDir>/projects/`, subagent transcripts included: each `assistant`
record's `message.usage`. Claude Code writes one record per content block,
each repeating its response's usage, and a resumed session copies records
into a new file, so a record counts once per message id and request id
across every file, the first by path. `input_tokens` already excludes cache
reads (`cache_read_input_tokens`) and writes
(`cache_creation_input_tokens`); `output_tokens_details.thinking_tokens` is
the reasoning. The `<synthetic>` placeholder model is not work, and
`usage.speed: "fast"` work has no charge.

### OpenAI

```ts
import { openai } from "@foundry/usage/providers/openai";

interface OpenAILogin extends Credential {
  readonly provider: "openai";
  readonly kind: "login";
  readonly home: string; // absolute
}

interface OpenAIApiKey extends Credential {
  readonly provider: "openai";
  readonly kind: "api-key";
  readonly key: string;
}

type OpenAICredential = OpenAILogin | OpenAIApiKey;

interface OpenAIProvider extends Provider {
  readonly id: "openai";
  login(options?: { readonly home?: string }): OpenAILogin; // "~" allowed
  apiKey(key: string): OpenAIApiKey;
  detect(): Promise<readonly OpenAICredential[]>;
  price(model: string, quantities: Quantities): Charge | undefined; // basis "priced"
}
```

Limits come from a short-lived `codex app-server`, started as `codex` from
`PATH`: the `initialize` handshake, then `account/read` and
`account/rateLimits/read`. No turn runs, and the server is killed on every
path.

| Codex reports | Becomes |
|---|---|
| `primary`, `secondary` | windows named by `windowDurationMins`: 300 is `five-hour-window`, 10080 is `weekly-window`, any other `<n>-minute-window`. Only with no duration does position decide: primary 5 hours (30 days on `free` and `go`), secondary a week. On Pro the primary is the weekly window and the secondary is null. |
| `credits.balance`, unless `unlimited` | a credit balance |
| `rateLimitResetCredits` | `details.openai.resetCredits`: the available count and the soonest expiry |
| `rateLimitReachedType` | `details.openai.limitReached` |
| `accountId` (else the workspace's `chatgptAccountId`, else the email), email, `planType` | `account` |
| a login on an API key or Amazon Bedrock | `unsupported` |

The `codex` entry of `rateLimitsByLimitId` wins over the older
`rateLimits`, and a snapshot for any other limit id is not read.
`individualLimit` is not read.

Consumption comes from the rollouts under `<home>/sessions/` and
`<home>/archived_sessions/`. Each `token_count` event carries the request's
own usage (`last_token_usage`) and the session's running total
(`total_token_usage`); the model is the last `turn_context`'s. A request
counts once: a running total equal to the one before is a re-emission, a
request with no input or output marks context size, and the history a
forked rollout copies from its parent (its first `session_meta` names a
parent, and the copies follow it within a second of each other) only sets
the baseline. A rollout found under both directories counts once. Codex
counts cached input inside `input_tokens`, so it is taken out; reasoning is
inside output. Work on a `priority`, `fast` or `ultrafast` service tier has
no charge.

### Provider details

What only one provider reports goes in `details`, typed by that provider.
Claude's extra-usage state and its model-scoped weekly windows, and Codex's
reset credits and limit-reached reason, live there:

```ts
// @foundry/usage/providers/anthropic
interface AnthropicDetails {
  readonly extraUsage?: { readonly enabled: boolean; readonly disabledReason?: string };
  readonly modelWindows?: Readonly<Record<string, string>>; // window id → the model it applies to
}

// @foundry/usage/providers/openai
interface OpenAIDetails {
  readonly limitReached?: string;
  readonly resetCredits?: { readonly available: number; readonly nextExpiresAt?: Date };
}
```

Each provider adds its member to `ProviderDetails`, keyed by its id, so
`account.details?.anthropic?.modelWindows` is typed. A provider of your own
does the same by declaration merging:

```ts
declare module "@foundry/usage" {
  interface ProviderDetails {
    readonly myProvider?: MyProviderDetails;
  }
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
