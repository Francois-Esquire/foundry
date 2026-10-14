// One source behavior; the story file holds three more.
export interface Card {
  title: string;
}

export function makeCard(): Card {
  return { title: "" };
}
