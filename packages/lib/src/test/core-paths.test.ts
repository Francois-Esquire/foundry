import {
  FOUNDRY_PATHS,
  FOUNDRY_ROOT_DIR,
  FOUNDRY_ROOT_ENV,
  resolveFoundryPaths,
  resolvePathTemplates,
} from "@foundry/core/paths";
import { describe, expect, it } from "vitest";

describe("@foundry/core/paths", () => {
  it("names the Foundry root variable and directory", () => {
    expect(FOUNDRY_ROOT_ENV).toBe("FOUNDRY_ROOT");
    expect(FOUNDRY_ROOT_DIR).toBe(".foundry");
  });

  it("resolves every Foundry path under the root", () => {
    expect(resolveFoundryPaths("/srv/foundry")).toEqual({
      artifacts: "/srv/foundry/artifacts",
      marbles: "/srv/foundry/marbles",
      modules: "/srv/foundry/modules",
      processes: "/srv/foundry/processes",
      skills: "/srv/foundry/skills",
      spyglass: "/srv/foundry/spyglass",
    });
    expect(Object.keys(resolveFoundryPaths("/srv"))).toEqual(
      Object.keys(FOUNDRY_PATHS)
    );
  });

  it("trims trailing separators from a root before joining", () => {
    expect(resolveFoundryPaths("/srv/foundry//").processes).toBe(
      "/srv/foundry/processes"
    );
    expect(resolveFoundryPaths("/").processes).toBe("/processes");
    expect(resolveFoundryPaths("C:\\foundry\\", "\\").processes).toBe(
      "C:\\foundry\\processes"
    );
  });

  it("expands named placeholders, converting only the template's separators", () => {
    expect(
      resolvePathTemplates(
        { log: "{STATE}/logs/{NAME}.log" },
        { NAME: "daemon", STATE: "C:/state" },
        "\\"
      )
    ).toEqual({ log: "C:/state\\logs\\daemon.log" });
  });

  it("refuses a placeholder no root names", () => {
    expect(() => resolvePathTemplates({ a: "{MISSING}/a" }, {})).toThrow(
      "no root named MISSING"
    );
  });
});
