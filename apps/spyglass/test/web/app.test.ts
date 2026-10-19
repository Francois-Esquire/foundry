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
    study: false,
  });
  expect(readSession("?view=map")).toEqual({
    developer: false,
    mapOnly: true,
    study: false,
  });
});

it("enables development only on the dev server, without a production query bypass", () => {
  vi.stubEnv("DEV", false);
  expect(readSession("?dev").developer).toBe(false);
  expect(readSession("?view=map&dev=1")).toEqual({
    developer: false,
    mapOnly: true,
    study: false,
  });
  vi.stubEnv("DEV", true);
  expect(readSession("").developer).toBe(true);
});

it("keeps the local rendering study behind development mode", () => {
  vi.stubEnv("DEV", false);
  expect(readSession("?scene=harbor").study).toBe(false);
  vi.stubEnv("DEV", true);
  expect(readSession("?scene=harbor").study).toBe(true);
});
