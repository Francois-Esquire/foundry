import { modulesRouter } from "./modules";
import { runtimeRouter } from "./runtime";
import { vaultRouter } from "./vault";

export const router = {
  modules: modulesRouter,
  runtime: runtimeRouter,
  vault: vaultRouter,
};

export type AppRouter = typeof router;
