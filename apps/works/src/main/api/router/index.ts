import { accessRouter } from "./access";
import { artifactsRouter } from "./artifacts";
import { auditRouter } from "./audit";
import { authoringRouter } from "./authoring";
import { moduleSettingsRouter } from "./module-settings";
import { modulesRouter } from "./modules";
import { powerRouter } from "./power";
import { runtimeRouter } from "./runtime";
import { themeRouter } from "./theme";
import { vaultRouter } from "./vault";

export const router = {
  access: accessRouter,
  artifacts: artifactsRouter,
  audit: auditRouter,
  authoring: authoringRouter,
  moduleSettings: moduleSettingsRouter,
  modules: modulesRouter,
  power: powerRouter,
  runtime: runtimeRouter,
  theme: themeRouter,
  vault: vaultRouter,
};

export type AppRouter = typeof router;
