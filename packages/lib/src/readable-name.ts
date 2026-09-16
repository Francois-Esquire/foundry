import {
  adjectives,
  animals,
  uniqueNamesGenerator,
} from "unique-names-generator";

/**
 * Creates a short, human-readable label for durable product identity.
 *
 * The generator library remains an implementation detail: callers only get
 * the stable two-word, title-cased form, rather than its dictionaries or
 * configuration surface.
 */
export function generateReadableName(): string {
  return generateReadableNameWithSeed(Math.floor(Math.random() * 2 ** 32));
}

/** Test-only deterministic seam; it is deliberately not exported from the barrel. */
export function generateReadableNameWithSeed(seed: number | string): string {
  return uniqueNamesGenerator({
    dictionaries: [adjectives, animals],
    length: 2,
    seed,
    separator: " ",
    style: "capital",
  });
}
