import type { ModelSelection } from "@foundry/models";
import { hostModels } from "~/authoring/runtime";

export const models = {
  available(selection: ModelSelection): boolean {
    return hostModels()?.available(selection) ?? false;
  },
};
