import { writeFileSync } from "node:fs";
import { grammars } from "../src/grammar";

for (const [file, grammar] of Object.entries(grammars())) {
  writeFileSync(
    new URL(`../syntaxes/${file}`, import.meta.url),
    `${JSON.stringify(grammar, null, 2)}\n`
  );
}
