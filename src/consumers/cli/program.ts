import { termost } from "termost";

import pkg from "../../../package.json";
import { FoundryLibrary } from "../../core";

type ProgramContext = {
  prompt: string;
  research: boolean;
  auto: boolean;
  model: string;
  role: string;
  temperature: number;
  numTasks: string;
  status: string;
  withSubtasks: boolean;
  id: string;
  from: string;
  output: string;
  dependencies: string;
  priority: string;
  file: string;
  force: boolean;
  append: boolean;
  dependsOn: string;
  all: boolean;
  num: string;
  threshold: number;
  confirm: boolean;
  convert: boolean;
  skipGenerate: boolean;
};

const { name, version } = pkg;

const foundry = new FoundryLibrary();

export const program = termost<ProgramContext>({
  name,
  description: "Foundry: A CLI tool for AI-powered software development",
  version,
  onException(error) {
    console.error(`Error: ${error.message}`);
  },
  onShutdown() {
    console.log("Foundry CLI has been shut down.");
  },
});
