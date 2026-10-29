# @foundry/usage

What an AI provider lets an account consume, and what that consumption
costs, as it is at the moment you ask. A Claude Max login has an hourly
window and a weekly one, each seen only as a share used; a ChatGPT Pro login
has a weekly window and a credit balance; an API key is billed per use in
money. This package describes all of them in one model, so "how much
headroom does this account have, and when does it come back?" is asked the
same way for each. The glossary is `CONTEXT.md`.

It observes and reports. It keeps nothing: no store, no cache, no record of
its own. Nothing here limits work, blocks it, or acts on a value.

## Usage

```ts
import { usage } from "@foundry/usage";
import { anthropic } from "@foundry/usage/providers/anthropic";
import { openai } from "@foundry/usage/providers/openai";

await usage.initialize(); // adds and returns the signed-in default accounts

usage.add(anthropic({ name: "work", configDir: "~/.claude-work" }));
usage.add(openai({ name: "personal", home: "~/.codex-personal" }));
usage.add(anthropic({ name: "api", apiKey: process.env.ANTHROPIC_API_KEY }));

const claude = await usage.query("anthropic"); // one Snapshot
const all = await usage.query({ since: "1d" }); // readonly Snapshot[], every added account

claude.weekly?.usedPercent; // 53
claude.weekly?.headroom.share; // 0.47
claude.hourly?.resetsIn; // ms, measured from claude.at
claude.hourly?.exhausted; // false
claude.limits.find(
  (limit) => limit.kind === "window" && limit.model === "Fable"
); // the Fable-only weekly window
claude.consumption?.total; // { inputTokens, outputTokens, … } since the weekly window started
claude.details?.anthropic?.extraUsage;
```

- **Names.** Every added account has a `name`, unique among added
  accounts. A provider function's `name` defaults to the provider id, so
  `anthropic()` is the default account, named `anthropic`. Adding a name
  that is taken throws. `usage.add` returns the name, and registers the
  account's provider if no provider with its id is registered.
- **`usage.initialize()`** can be called at any time, any number of times.
  For each registered provider whose id is not yet a name, it asks for the
  default account (the machine's default Claude Code or Codex login) and
  adds it when it looks signed in. It asks no provider for limits, and an
  API key in the environment is never a default account. It returns the
  default accounts now added, whoever added them: each `Account` named after
  its provider.
- **`usage.query(name, options?)`** reads one account; an unknown name
  rejects. **`usage.query(options?)`** reads every added account in
  parallel, a snapshot each; `options.provider` narrows to one provider.
- **`since`** is a `Date` or a span back from now: a number and `m`, `h`,
  `d` or `w`. Without it, consumption starts where the account's weekly
  window started, its `resetsAt` less its `duration`. With no weekly window,
  no `resetsAt`, or a limits read that failed, it covers the 7 days before
  `at`. So without `since` the history is read after the limits; with it,
  both are read at once. Files last written before the start are skipped
  unread.
- **Nothing is kept between queries.** Each login read starts its client
  (Claude Code about 1.8 s, Codex about 1.1 s), so a caller decides how often
  to ask, and holds the last snapshot itself if it wants one.
- `usage.use(provider)` registers a provider so `initialize` knows it. The
  package entry registers `anthropic` and `openai`; nothing else happens on
  import.

A workflow step that waits out a weekly window:

```ts
const work = await usage.query("work");
if (work.weekly && work.weekly.headroom.share < 0.1) {
  return { deferUntil: work.weekly.resetsAt };
}
```

## The model

Four billing models cover the accounts Foundry works with, one kind of
limit each:

| Billing model | Limit | Unit | Comes back | One piece of work |
|---|---|---|---|---|
| Allowance | window | percent of a span of time | when the window ends | has no price in the window; its charge is notional |
| Metered | spend cap | money | each billing period | is priced in money, and is spend |
| Prepaid | balance | money | when topped up | is priced in money, and is spend |
| Credits | credit balance | the provider's credits | when topped up; credits can expire | costs what the provider says in credits |

Billing models belong to limits, not accounts: a Claude Max account has two
windows and, with extra usage on, a spend cap.

A **snapshot** is one account's usage at the moment it was queried. It is
plain data, with no methods, and survives JSON.

```ts
interface Snapshot {
  readonly name: string; // "work"
  readonly provider: string; // "anthropic"
  readonly at: Date; // when its limits were read: stamped just before asking
  readonly identity?: Identity; // who the provider says it is; absent when the limits read failed
  readonly limits: readonly Limit[]; // every limit reported, resolved; empty when none was read
  readonly hourly?: Window; // the account-wide window of each span, from `limits`
  readonly weekly?: Window;
  readonly monthly?: Window;
  readonly spendCap?: SpendCap; // the limit of each kind, from `limits`
  readonly balance?: Balance;
  readonly credits?: CreditBalance;
  readonly consumption?: Consumption;
  readonly failed?: string; // the limits could not be read this query
  readonly consumptionFailed?: string; // the history could not be read this query
  readonly unsupported?: string; // this credential never has limits; not an error
  readonly details?: ProviderDetails;
}

interface Identity {
  readonly id: string;
  readonly email?: string;
  readonly plan?: string; // "max", "pro"
}

// What usage.add takes and usage.initialize returns.
interface Account<C = unknown> {
  readonly name: string;
  readonly provider: Provider; // { id, defaultAccount() }
  readonly credential: C; // the provider's routing data, such as a config dir
  limits(): Promise<Reading>;
  history(since: Date): Promise<Consumption | undefined>;
}

// Every limit carries what follows from it, worked out when the snapshot is built.
interface Resolution<H extends Headroom = Headroom> {
  readonly headroom: H; // Required<Headroom>, with `share`, on windows and spend caps
  readonly resetsIn?: Duration; // from the snapshot's `at`; absent when it never resets
  readonly exhausted: boolean; // no headroom left
}

interface Headroom {
  readonly remaining: number; // in the limit's own unit
  readonly unit: "percent" | "usd" | "credits";
  readonly share?: number; // 0 to 1, only when the limit has a total
}

interface Window extends Resolution {
  readonly kind: "window";
  readonly span: "hourly" | "weekly" | "monthly" | "custom";
  readonly duration: Duration; // ms
  readonly usedPercent: number; // 0 to 100
  readonly resetsAt?: Date;
  readonly model?: string; // a per-model window: "Fable"
}

interface SpendCap extends Resolution {
  readonly kind: "spend-cap";
  readonly used: Money;
  readonly cap: Money;
  readonly resetsAt?: Date;
}

interface Balance extends Resolution {
  readonly kind: "balance";
  readonly remaining: Money;
}

interface CreditBalance extends Resolution {
  readonly kind: "credit-balance";
  readonly remaining: number;
  readonly expiresAt?: Date; // expiry is not a reset
}

type Limit = Window | SpendCap | Balance | CreditBalance;

interface Money {
  readonly amount: number;
  readonly unit: "usd";
}

interface Consumption {
  readonly since: Date;
  readonly total: Quantities;
  readonly charge?: Charge; // only when every entry has one
  readonly bySession: readonly SessionConsumption[]; // one per session and model
}

interface SessionConsumption {
  readonly session: string; // the client's own session id
  readonly model: string; // as the client recorded it
  readonly quantities: Quantities;
  readonly charge?: Charge; // only when all of its work was priced
}

// Input, cached input, cache write and output are disjoint; reasoning is
// the part of output spent reasoning. A zero count is left out.
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
```

`limits` lists every limit the provider reported, in its order, per-model
and custom windows included. `hourly`, `weekly` and `monthly` are the
account-wide window of their span, the one with no `model`; `spendCap`,
`balance` and `credits` are the limit of their kind. Each is the same object
as its entry in `limits`. A per-model window, such as Claude's Fable weekly
window, is found in `limits` by its `model`.

Limits and consumption are separate reads, and one failing never hides the
other. A limits read that fails sets `failed`, with no limits and no
`identity`; a history read that fails sets `consumptionFailed`. A signed-out
login, a client that does not answer in time (Claude Code 10 s to start and
5 s to report, Codex 5 s in all), and a signed-in login that reports no
limits all fail. Two names that reach one account get a snapshot each, with
the same `identity.id`.

Consumption comes from the history each client already writes under its
config directory, so work done outside Foundry counts too. A login's work
runs on an allowance, so its charges are `notional`: list prices from the
models.dev snapshot bundled in `@foundry/models`. A model it does not list
exactly, and work at a fast or priority tier, has no charge. An API key has
no local history, so its `consumption` is absent.

## Writing a provider

A provider author imports `@foundry/usage/provider` and describes a provider
to `defineProvider`: how the caller's options become a credential, how to
find the default account, and how to read limits and history through a
credential. Its types are inferred from the definition. A made-up Acme CLI
that keeps its state in `status.json`:

```ts
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { usage } from "@foundry/usage";
import {
  consumptionOf,
  credits,
  defineProvider,
  listPrices,
  type Work,
  window,
} from "@foundry/usage/provider";

interface AcmeStatus {
  readonly email: string;
  readonly plan: string;
  readonly weekPercent: number;
  readonly weekResetsAt: string;
  readonly credits: number;
  readonly work: readonly Work[];
}

const statusOf = async (home: string): Promise<AcmeStatus> =>
  JSON.parse(await readFile(join(home, "status.json"), "utf8"));

export const acme = defineProvider({
  id: "acme",
  // The caller's options, without `name`, become the credential each read gets.
  credential: ({ home }: { readonly home?: string }) =>
    home ?? join(homedir(), ".acme"),
  // The default account's options when it looks signed in: presence only.
  detect: () =>
    access(join(homedir(), ".acme", "status.json")).then(
      () => ({}),
      () => undefined
    ),
  // Throw, and the snapshot's `failed` says why.
  limits: async (home) => {
    const status = await statusOf(home);
    return {
      identity: { id: status.email, email: status.email, plan: status.plan },
      limits: [
        window.weekly({
          usedPercent: status.weekPercent,
          resetsAt: new Date(status.weekResetsAt),
        }),
        credits({ remaining: status.credits }),
      ],
    };
  },
  // Throw, and `consumptionFailed` says why. Leave it out for no consumption.
  history: async (home, since) => {
    const { work } = await statusOf(home);
    const recent = work.filter((piece) => piece.at >= since.getTime());
    return consumptionOf(recent, since, listPrices("acme"), "notional");
  },
});

usage.use(acme); // so `usage.initialize()` asks for its default account
usage.add(acme({ name: "work", home: "/home/me/.acme-work" }));
acme({ configDir: "/x" }); // a type error: the options are typed
```

A `Reading` may also carry `details` and, for a credential that never has
limits, `unsupported`. The builders return a limit as reported; the core
adds `headroom`, `resetsIn` and `exhausted`.

| Builder | Makes |
|---|---|
| `window.hourly({ hours, usedPercent, resetsAt?, model? })` | an hourly window of `hours` |
| `window.weekly({ usedPercent, resetsAt?, model? })` | a 7-day window |
| `window.monthly({ usedPercent, resetsAt?, model? })` | a 30-day window |
| `window.custom({ duration, usedPercent, resetsAt?, model? })` | a window of any other length, in ms |
| `spendCap({ used, cap, resetsAt? })` | a spend cap, in dollars |
| `balance({ remaining })` | a prepaid balance, in dollars |
| `credits({ remaining, expiresAt? })` | a credit balance, in the provider's unit |

`usedPercent` is clamped to 0 to 100, and an absent field is left out.

For consumption, the kit has `consumptionOf(works, since, price, basis)`,
which groups `Work` (one response: `at`, `model`, `quantities`, `session`,
`standardSpeed`) per session and model, pricing each piece on its own;
`listPrices(vendor)`, list prices from the bundled models.dev snapshot; and
`quantities(counts)`, which drops zero counts.

What only one provider reports goes in `details`, translated, never the raw
response. Nothing essential lives there, and a field moves into the model
once a second provider reports it. A provider types its member by
declaration merging:

```ts
declare module "@foundry/usage" {
  interface ProviderDetails {
    readonly acme?: AcmeDetails;
  }
}
```

## Built-in providers

Each is an anti-corruption layer in its own folder under `src/providers/`,
built with the kit. Each login reads only its own directory: Claude Code
starts with `CLAUDE_CONFIG_DIR` set to `configDir`, and Codex with
`CODEX_HOME` set to `home`. The one exception is `~/.claude` itself: Claude
Code keeps that login's account file at `~/.claude.json`, and with
`CLAUDE_CONFIG_DIR=~/.claude` it looks inside the directory and reads as
signed out, so for it `CLAUDE_CONFIG_DIR` is left unset. An inherited
`CLAUDE_CONFIG_DIR` or `CODEX_HOME`, and any `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY` or
`CODEX_API_KEY`, is removed from the spawned client's environment, so a key
never stands in for a login. An API key has no limits to read, so it is
`unsupported`, with no consumption. Claude Code rewrites a login's account
file each time it starts, keeping a few rotating backups under
`<configDir>/backups/`; this package writes nothing itself.

| Provider | Options | Default account | Looks signed in when |
|---|---|---|---|
| `anthropic` | `{ configDir? }` or `{ apiKey }`; an empty or unset `apiKey` throws | `CLAUDE_CONFIG_DIR`, else `~/.claude` | `.credentials.json` is in it, or its account file is there (`~/.claude.json` for `~/.claude`, `<dir>/.claude.json` otherwise) |
| `openai` | `{ home? }` or `{ apiKey }`; an empty or unset `apiKey` throws | `CODEX_HOME`, else `~/.codex` | `auth.json` is in it |

### Anthropic

Limits come from Claude Code itself: the `claude` on `PATH` (the Agent SDK's
bundled CLI when there is none) is started through the Agent SDK with a
prompt that never yields, so nothing reaches the model, and asked for its
account and then `/usage`. It loads no settings, hooks, tools or MCP
servers, keeps no transcript, and is closed on every path.

| Claude reports | Becomes |
|---|---|
| `five_hour` | the hourly window, 5 hours |
| `seven_day` | the weekly window |
| each `model_scoped` entry, such as Fable | a weekly window with `model: "Fable"`, found in `limits` |
| `spend` or `extra_usage`, while enabled and in USD | a spend cap in dollars |
| `extra_usage` on or off, and why | `details.anthropic.extraUsage` |
| account email, `subscription_type` | `identity`: `id` is the email lowercased, `plan` such as `max` |
| an API key, a cloud provider, or `rate_limits_available: false` | `unsupported` |

Consumption comes from the transcripts under `<configDir>/projects/`,
subagent transcripts included: each `assistant` record's `message.usage`.
Claude Code writes one record per content block, each repeating its
response's usage, and a resumed session copies records into a new file, so
a record counts once per message id and request id across every file, the
first by path. `input_tokens` already excludes cache reads and writes;
`output_tokens_details.thinking_tokens` is the reasoning. The `<synthetic>`
placeholder model is not work, and `usage.speed: "fast"` work has no charge.

### OpenAI

Limits come from a short-lived `codex app-server`, started as `codex` from
`PATH`: the `initialize` handshake, then `account/read` and
`account/rateLimits/read`. No turn runs, and the server is killed on every
path.

| Codex reports | Becomes |
|---|---|
| `primary`, `secondary` | windows by `windowDurationMins`: 300 is hourly (5 hours), 10080 weekly, 43200 monthly, any other custom. Only with no duration does position decide: primary 5 hours (30 days on `free` and `go`), secondary a week. On Pro the primary is the weekly window and the secondary is null. |
| `credits.balance`, unless `unlimited` | a credit balance |
| `rateLimitResetCredits` | `details.openai.resetCredits`: the available count and the soonest expiry |
| `rateLimitReachedType` | `details.openai.limitReached` |
| `accountId` (else the workspace's `chatgptAccountId`, else the email), email, `planType` | `identity` |
| a login on an API key or Amazon Bedrock | `unsupported` |

The `codex` entry of `rateLimitsByLimitId` wins over the older
`rateLimits`, and a snapshot for any other limit id is not read.

Consumption comes from the rollouts under `<home>/sessions/` and
`<home>/archived_sessions/`. Each `token_count` event carries the request's
own usage (`last_token_usage`) and the session's running total; the model
is the last `turn_context`'s. A request counts once: a running total equal
to the one before is a re-emission, a request with no input or output marks
context size, and the history a forked rollout copies from its parent (its
first `session_meta` names a parent, and the copies follow within a second
of each other) only sets the baseline. A rollout found under both
directories counts once. Codex counts cached input inside `input_tokens`,
so it is taken out; reasoning is inside output. Work on a `priority`,
`fast` or `ultrafast` service tier has no charge.

## Not here

- Keeping anything: no store, no cache, no record of work. The clients' own
  history is the only record, and this package only reads it.
- Asking in the background. A provider is asked only when a caller queries.
- Limits Foundry sets itself, budgets, or policies.
- Knowing what a session was for. A caller that knows groups by session.

## Decisions

- [0001: Usage keeps nothing; a query reads it as it is now](docs/adr/0001-usage-keeps-nothing.md)
- [0002: Consumers read resolved snapshots per account; provider authors get the building blocks](docs/adr/0002-resolved-snapshots-per-account.md)
