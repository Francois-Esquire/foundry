import type { Money, UsageTotal } from "~/model/usage";

const SMALL = 1;
const THOUSAND = 1000;
const MILLION = 1_000_000;

const SMALL_DIGITS = 4;
const SMALLEST_SHOWN = (1 / 10 ** SMALL_DIGITS).toFixed(SMALL_DIGITS);

function money({ amount, currency }: Money): string {
  const digits = amount < SMALL ? SMALL_DIGITS : 2;
  const fixed = amount.toFixed(digits);
  const tiny = amount > 0 && Number(fixed) === 0;
  const shown = tiny ? SMALLEST_SHOWN : fixed;
  const bound = tiny ? "<" : "";
  return currency === "USD"
    ? `${bound}$${shown}`
    : `${bound}${shown} ${currency}`;
}

function amounts(values: readonly Money[], basis: string): string[] {
  return values.map((value) => `${money(value)} ${basis}`);
}

function turnCount(value: number): string {
  return value === 1 ? "1 turn" : `${value} turns`;
}

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

function elsewhere(total: UsageTotal): string {
  return [
    ...(total.unreadable > 0 ? [records(total.unreadable)] : []),
    ...(total.unattributed > 0 ? [unattributedTurns(total.unattributed)] : []),
  ].join(", ");
}

function hasElsewhere(total: UsageTotal): boolean {
  return total.unreadable > 0 || total.unattributed > 0;
}

function isEmpty(total: UsageTotal): boolean {
  return total.turns === 0 && !hasElsewhere(total);
}

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

export const UNPRICED_COST_CELL = "cost ?";

export function costCell(total: UsageTotal | undefined): string {
  if (!total || isEmpty(total)) {
    return "";
  }
  const parts = [
    ...total.reported.map(money),
    ...total.estimated.map((value) => `~${money(value)}`),
  ];
  if (parts.length === 0) {
    return UNPRICED_COST_CELL;
  }
  const incomplete =
    total.unpriced > 0 || total.missing > 0 || hasElsewhere(total);
  return `${parts.join("+")}${incomplete ? "+?" : ""}`;
}
