import {
  adjectives,
  animals,
  uniqueNamesGenerator,
} from "unique-names-generator";

export function generateReadableName(): string {
  return generateReadableNameWithSeed(Math.floor(Math.random() * 2 ** 32));
}

export function generateReadableNameWithSeed(seed: number | string): string {
  return uniqueNamesGenerator({
    dictionaries: [adjectives, animals],
    length: 2,
    seed,
    separator: " ",
    style: "capital",
  });
}
