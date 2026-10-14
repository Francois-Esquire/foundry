import { expect, it } from "vitest";
import { placeFiles } from "../../src/lib/file-placement";

it("matches the original folder-anchored import solver's recorded coordinates", () => {
  const files = ["src/a.ts", "src/b.ts", "src/ui/a.ts", "test/a.test.ts"].map(
    (id) => ({
      directory: id.slice(0, id.lastIndexOf("/")),
      id,
      x: 0,
      y: 0,
    })
  );
  placeFiles(files, 60, [
    { source: "src/a.ts", target: "src/b.ts" },
    { source: "src/ui/a.ts", target: "src/a.ts" },
  ]);
  // Captured from the solver before the lattice replacement, at 3e93b64^.
  const original = [
    { x: 1.697_479_415_892_331, y: -5.836_934_101_189_197 },
    { x: 5.139_092_765_079_855, y: -2.209_910_865_160_203 },
    { x: 7.750_483_275_653_722, y: -8.078_170_875_488_249 },
    { x: -7.439_092_351_311_735, y: -16.714_843_537_934_97 },
  ];
  for (const [i, expected] of original.entries()) {
    expect(files[i]?.x).toBeCloseTo(expected.x, 10);
    expect(files[i]?.y).toBeCloseTo(expected.y, 10);
  }
});
