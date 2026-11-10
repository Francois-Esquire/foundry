import { describe, expect, it } from "vitest";
import { PLACES, resolveRoute } from "~/app/places";

describe("PLACES", () => {
  it("lists the eight places in the order of the strip", () => {
    expect(PLACES.map((place) => place.id)).toEqual([
      "import",
      "library",
      "coverage",
      "studio",
      "generate",
      "reconstruct",
      "proof",
      "export",
    ]);
  });

  it("gives every place a name and a symbol of its own", () => {
    for (const place of PLACES) {
      expect(place.name).not.toBe("");
    }
    expect(new Set(PLACES.map((place) => place.symbol)).size).toBe(8);
    expect(new Set(PLACES.map((place) => place.name)).size).toBe(8);
  });
});

describe("resolveRoute", () => {
  it("opens the first place for an empty path", () => {
    expect(resolveRoute([])).toEqual({
      destination: PLACES[0],
      kind: "destination",
      path: [],
    });
  });

  it("finds a place and hands the rest of the path to its screen", () => {
    const route = resolveRoute(["studio", "lato-regular", "a"]);
    expect(route.kind).toBe("destination");
    if (route.kind === "destination") {
      expect(route.destination.id).toBe("studio");
      expect(route.path).toEqual(["lato-regular", "a"]);
    }
  });

  it("reaches the design system, which is not a place in the strip", () => {
    const route = resolveRoute(["system"]);
    expect(route.kind).toBe("destination");
    if (route.kind === "destination") {
      expect(route.destination.screen).toBeDefined();
    }
    expect(PLACES.some((place) => place.id === "system")).toBe(false);
  });

  it("reports an address that names no place", () => {
    expect(resolveRoute(["nowhere", "at all"])).toEqual({
      address: "#/nowhere/at%20all",
      kind: "unknown",
    });
  });
});
