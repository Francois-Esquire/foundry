import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gritRules } from "../src/prompts/grit";

const directory = resolve(import.meta.dirname, "../biome");
for (const [name, text] of Object.entries(gritRules())) {
  writeFileSync(resolve(directory, name), text);
  console.log(`wrote biome/${name}`);
}
