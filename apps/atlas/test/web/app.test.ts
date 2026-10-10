import { afterEach, expect, it, vi } from "vitest";
import { readSession } from "../../src/web/ui/app";

afterEach(() => {
  vi.unstubAllEnvs();
});

it("opens a reader's session from a built page without ?dev", () => {
  vi.stubEnv("DEV", false);
  expect(readSession("")).toEqual({ developer: false, mapOnly: false });
  expect(readSession("?view=map")).toEqual({
    developer: false,
    mapOnly: true,
  });
});

it("opens a developer session with ?dev, or on the dev server", () => {
  vi.stubEnv("DEV", false);
  expect(readSession("?dev").developer).toBe(true);
  expect(readSession("?view=map&dev=1")).toEqual({
    developer: true,
    mapOnly: true,
  });
  vi.stubEnv("DEV", true);
  expect(readSession("").developer).toBe(true);
});
