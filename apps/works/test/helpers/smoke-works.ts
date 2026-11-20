import path from "node:path";
import { ModelManager } from "@foundry.sh/marbles/engine";
import { electronNativeTheme } from "~/main/system/native-theme";
import { systemTheme } from "~/main/system/theme";
import { composeWorks, type WorksOptions } from "~/main/works";

export async function smokeWorks(
  userData: string,
  options: Partial<WorksOptions> = {}
) {
  await systemTheme.open({
    file: path.join(userData, "theme.json"),
    native: electronNativeTheme,
  });
  return await composeWorks({
    artifactRoot: path.join(userData, "foundry", "artifacts"),
    models: new ModelManager(),
    moduleRoot: path.join(userData, "foundry", "modules"),
    print: (line) => process.stderr.write(`${line}\n`),
    routes: {
      route: () => {
        throw new Error("No models in this smoke");
      },
    },
    theme: systemTheme,
    userData,
    ...options,
  });
}
