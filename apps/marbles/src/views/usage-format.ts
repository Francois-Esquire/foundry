import type { Money, UsageTotal } from "~/model/usage";

/**
 * How a usage total reads. A cost is never printed for turns without a
 * price, and "no usage recorded" never reads as a zero cost.
 */

const SMALL = 1;
const THOUSAND = 1000;
const MILLION = 1_000_000;

function money({ amount, currency }: Money): string {
  const digits = amount < SMALL ? 4 : 2;
  return currency === "USD"
    ? `$${amount.toFixed(digits)}`
    : `${amount.toFixed(digits)} ${currency}`;
}

function amounts(values: readonly Money[], basis: string): string[] {
  return values.map((value) => `${money(value)} ${basis}`);
}

function turnCount(value: number): string {
  return value === 1 ? "1 turn" : `${value} turns`;
}

/** What keeps a total from being complete: unpriced turns, and turns whose usage was not recorded. */
function gaps(total: UsageTotal): string[] {
  return [
    ...(total.unpriced > 0 ? [`${total.unpriced} unpriced`] : []),
    ...(total.missing > 0 ? [`${total.missing} not recorded`] : []),
  ];
}

function records(value: number): string {
  return value === 1
    ? "1 unreadable usage record"
    : `${value} unreadable usage records`;
}

function unattributedTurns(value: number): string {
  return value === 1 ? "1 unattributed turn" : `${value} unattributed turns`;
}

/** What may belong to a total besides its own turns. */
function elsewhere(total: UsageTotal): string {
  return [
    ...(total.unreadable > 0 ? [records(total.unreadable)] : []),
    ...(total.unattributed > 0 ? [unattributedTurns(total.unattributed)] : []),
  ].join(", ");
}

function hasElsewhere(total: UsageTotal): boolean {
  return total.unreadable > 0 || total.unattributed > 0;
}

/** Nothing recorded and nothing that may belong: never read as a zero cost. */
function isEmpty(total: UsageTotal): boolean {
  return total.turns === 0 && !hasElsewhere(total);
}

/** Said after any total that unreadable records or unattributed turns may belong to. */
function unreadableNote(total: UsageTotal): string {
  return hasElsewhere(total) ? ` · may be incomplete: ${elsewhere(total)}` : "";
}

function pricedLabel(total: UsageTotal): string {
  const priced = [
    ...amounts(total.reported, "reported"),
    ...amounts(total.estimated, "est."),
  ];
  const missing = gaps(total);
  if (priced.length === 0) {
    return total.missing === 0
      ? `unknown · ${turnCount(total.turns)} unpriced`
      : `unknown · ${turnCount(total.turns)}: ${missing.join(", ")}`;
  }
  if (missing.length === 0) {
    return priced.join(" + ");
  }
  let of = `of ${total.turns} turns, ${missing.join(", ")}`;
  if (total.missing === 0) {
    of = `${total.unpriced} of ${total.turns} turns unpriced`;
  } else if (total.unpriced === 0) {
    of = `${total.missing} of ${total.turns} turns not recorded`;
  }
  return `${priced.join(" + ")} · partial: ${of}`;
}

/**
 * `$0.4210 est.`, `$1.20 reported + $0.05 est.`, `unknown`, with any
 * unpriced or unrecorded turns, and any unreadable records or unattributed
 * turns that may belong here, named, so a partial total never reads as
 * whole.
 */
export function costLabel(total: UsageTotal | undefined): string {
  if (!total || isEmpty(total)) {
    return "no usage recorded";
  }
  if (total.turns === 0) {
    return `unknown · ${elsewhere(total)} may belong here`;
  }
  return `${pricedLabel(total)}${unreadableNote(total)}`;
}

function count(value: number): string {
  if (value >= MILLION) {
    return `${(value / MILLION).toFixed(1)}M`;
  }
  if (value >= THOUSAND) {
    return `${(value / THOUSAND).toFixed(1)}k`;
  }
  return String(value);
}

/** `12.3k tokens (8.0k in · 4.3k out) · 3 turns`, with turns that reported none, or were not recorded, named. */
export function tokensLabel(total: UsageTotal | undefined): string {
  if (!total || isEmpty(total)) {
    return "no usage recorded";
  }
  if (total.turns === 0) {
    return `tokens unknown · ${elsewhere(total)} may belong here`;
  }
  const turns = turnCount(total.turns);
  const notes = [
    ...(total.untokened > 0
      ? [` · ${total.untokened} without token counts`]
      : []),
    ...(total.missing > 0 ? [` · ${total.missing} not recorded`] : []),
  ].join("");
  const suffix = `${notes}${unreadableNote(total)}`;
  if (total.untokened === total.turns) {
    return `tokens unknown · ${turns}${suffix}`;
  }
  const { tokens } = total;
  return `${count(tokens.total)} tokens (${count(tokens.input)} in · ${count(tokens.output)} out) · ${turns}${suffix}`;
}

/** The short form a run row shows: `~` marks an estimate, `+?` an incomplete total; blank when nothing was recorded. */
export function costCell(total: UsageTotal | undefined): string {
  if (!total || isEmpty(total)) {
    return "";
  }
  const parts = [
    ...total.reported.map(money),
    ...total.estimated.map((value) => `~${money(value)}`),
  ];
  if (parts.length === 0) {
    return "cost ?";
  }
  const incomplete =
    total.unpriced > 0 || total.missing > 0 || hasElsewhere(total);
  return `${parts.join("+")}${incomplete ? "+?" : ""}`;
}
