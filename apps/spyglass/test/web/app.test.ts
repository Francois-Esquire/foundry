import { afterEach, expect, it, vi } from "vitest";
import { readSession } from "../../src/web/ui/app";

afterEach(() => {
  vi.unstubAllEnvs();
});

it("opens a reader's session from a built page without ?dev", () => {
  vi.stubEnv("DEV", false);
  expect(readSession("")).toEqual({
    developer: false,
    mapOnly: false,
  });
  expect(readSession("?view=map")).toEqual({
    developer: false,
    mapOnly: true,
  });
});

it("enables development only on the dev server, without a production query bypass", () => {
  vi.stubEnv("DEV", false);
  expect(readSession("?dev").developer).toBe(false);
  expect(readSession("?view=map&dev=1")).toEqual({
    developer: false,
    mapOnly: true,
  });
  vi.stubEnv("DEV", true);
  expect(readSession("").developer).toBe(true);
});

it("ignores the removed demonstration scene query", () => {
  vi.stubEnv("DEV", true);
  expect(readSession("?scene=harbor")).toEqual(readSession(""));
});
