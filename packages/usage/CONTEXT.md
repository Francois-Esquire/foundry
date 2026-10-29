# Usage

The usage context describes what an AI provider lets an account consume and
what that consumption costs, as it is at the moment someone asks. It
observes and reports. It keeps nothing, and it never limits, blocks, or
decides anything.

## Language

### Who is billed

**Provider**:
The company that bills for model work, such as Anthropic or OpenAI.
_Avoid_: vendor, harness (a harness is the client that runs the work, such
as Claude Code or Codex)

**Account**:
One account added to usage, under a name: the provider it belongs to and
the credential that reaches it, such as a Claude Max login or a ChatGPT Pro
login. One provider can have several accounts on one machine.
_Avoid_: user, subscription (that is the plan), login (that is a
credential), named credential

**Identity**:
Who a provider says an account is: its own id for it, its email, and its
plan, learned when the account is queried. Two accounts with the same
identity are billed as one.
_Avoid_: account id, profile, user

**Credential**:
The identifier that routes a read to an account: a CLI login (its config
directory) or an API key. Two credentials can lead to the same identity.
_Avoid_: account, connection, auth

**Name**:
What one added account is called, unique among them. The caller chooses
it, such as `work`; a default account is named after its provider.
_Avoid_: id (the provider's own id for the account), key, alias, provider
instance

**Default account**:
The account a machine's default CLI login reaches: Claude Code's for
Anthropic, Codex's for OpenAI. It is named after its provider, `anthropic`
or `openai`.
_Avoid_: main account, primary account

**Plan**:
The commercial terms an account is on, such as Max or Pro. A plan decides
which limits the account has.
_Avoid_: tier (speed tiers are a pricing term), subscription

### How work is paid for

**Billing model**:
How an account pays for work under one limit: allowance, metered,
prepaid, or credits. It belongs to the limit, not the account, so one
account can combine several.
_Avoid_: billing type, payment mode

**Allowance**:
Capacity included in a flat fee, measured in windows. It is seen only
as a share used; one piece of work has no price in it.
_Avoid_: subscription (that is the plan), quota

**Metered**:
Billing per use, in money, after the fact. It has no capacity unless the
account holder sets a spend cap.
_Avoid_: pay-as-you-go, API billing

**Prepaid**:
Money paid upfront that work draws down at its price. It comes back only
when it is topped up. Anything that converts one to one to money is
prepaid, even when the provider calls it credits.
_Avoid_: wallet, deposit

**Credits**:
Capacity in the provider's own unit, which is neither money nor time. The
provider decides what work costs in credits. Credits can come with the
plan, be bought, or expire.
_Avoid_: tokens (a measure of model input and output), points, reset
credits (those reset a window early; they are not capacity for work)

### What is observed

**Limit**:
One measure of an account's capacity. Every limit is exactly one of four
kinds, one per billing model: a window, a spend cap, a balance, or a credit
balance. A limit is always the provider's, never one Foundry sets.
_Avoid_: budget, quota, cap

**Window**:
An allowance limit measured over a span of time, after which it resets.
Its span is **hourly**, **weekly**, **monthly**, or **custom**. A Claude
Max account has an hourly and a weekly window; a ChatGPT Pro account has
only a weekly one.
_Avoid_: usage window (the context already says usage), session
(Foundry's sessions are agent conversations), time window, rate limit,
period

**Hourly window**:
A window measured in hours rather than days. Claude's lasts five hours.
_Avoid_: five-hour window, session limit

**Spend cap**:
A metered limit: the most money an account may be billed in one billing
period, set by the account holder.
_Avoid_: budget, spending limit

**Balance**:
A prepaid limit: the money left to draw down.
_Avoid_: funds, wallet

**Credit balance**:
A credits limit: the credits left to draw down, counted in the provider's
unit.
_Avoid_: balance (that is money), allowance

**Reset**:
The moment a limit's capacity comes back. Windows reset at the end of
their span and spend caps each billing period. Balances and credit
balances never reset; they are topped up, and credits can expire.
_Avoid_: refresh, renewal

**Headroom**:
What is left of a limit, in the limit's own unit, and as a share too when
the limit has a total. A window or spend cap has both; a balance or credit
balance has only the amount, since its provider reports no total.
_Avoid_: remaining percent, availability

**Exhausted**:
A limit with no headroom left. An account with one exhausted limit can
still have headroom on another.
_Avoid_: blocked, rate limited

**Reading**:
What a provider reported about one account's limits when it was asked. A
reading is part of one snapshot and is not kept after it.
_Avoid_: snapshot (that also holds consumption and what follows from the
limits), status, probe (the act of asking for a reading)

**Query**:
Asking for usage as it is now, for one named account or for every added
account: limits from the provider, consumption from the account's own
history. A query is the only way usage is known.
_Avoid_: refresh, sync, poll

**Snapshot**:
One account's usage at the moment it was queried: its limits as just read,
with their headroom, time to reset, and whether they are exhausted, and its
consumption. A query for every account returns one snapshot per account.
Nothing in a snapshot is kept; the next query builds a new one.
_Avoid_: report, overview, dashboard, cache

### What is consumed

**History**:
The record a provider's client already keeps of an account's work, such as
the sessions Claude Code and Codex write under their config directories.
Consumption is read from it; this context never writes one.
_Avoid_: log, ledger, tracking

**Work**:
One thing a provider did for an account, as its history records it:
usually one model response, within one of the client's sessions.
_Avoid_: turn and run (those are a caller's words), job, request, task

**Consumption**:
What work used over a span of time, in the provider's units, read from the
account's history: input, cached input, cache write, output, and reasoning
tokens for a language model; images or seconds for a media model. On an
allowance it moves a window by an amount the provider never states.
_Avoid_: usage (the name of the whole context), tokens (one unit of
consumption), recording

**Charge**:
What one piece of work cost an account, in money or in credits.
**Reported** when the provider stated it, **priced** when computed from
list prices, **notional** when the work ran on an allowance and the figure
is only what it would have cost at list price.
_Avoid_: cost (ambiguous), bill

**Spend**:
Money actually owed or drawn down: the sum of metered and prepaid charges.
Notional charges are never spend, and neither are credit charges, which
stay in credits.
_Avoid_: cost, usage

**List price**:
A provider's published price per unit of work for one model.
_Avoid_: rate card, pricing
