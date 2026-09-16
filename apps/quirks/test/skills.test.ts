import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { skillsNamed } from "~/skills";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true });
  }
});

describe("skillsNamed", () => {
  it("reads SKILL.md and its files under the given root; unknown names are skipped", async () => {
    const root = mkdtempSync(join(tmpdir(), "quirks-skills-"));
    roots.push(root);
    mkdirSync(join(root, "review", "refs"), { recursive: true });
    writeFileSync(
      join(root, "review", "SKILL.md"),
      "---\nname: review\ndescription: Reviews code\n---\nRead the diff.\n"
    );
    writeFileSync(join(root, "review", "refs", "checklist.md"), "- lint\n");

    const skills = await skillsNamed(["review", "missing"], root);

    expect(skills.map((skill) => skill.name)).toEqual(["review"]);
    expect(Object.keys(skills[0]?.files ?? {})).toEqual(["refs/checklist.md"]);
  });
});
