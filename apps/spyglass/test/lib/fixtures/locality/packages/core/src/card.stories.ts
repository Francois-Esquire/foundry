import type { Card } from "./card";

export function primaryCard(): Card {
  return { title: "primary" };
}

export function secondaryCard(): Card {
  return { title: "secondary" };
}

export function titleOf(card: Card): string {
  return card.title;
}
