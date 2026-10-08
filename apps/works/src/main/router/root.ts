import { modulesRouter } from "./modules";
import { vaultRouter } from "./vault";

export const router = { modules: modulesRouter, vault: vaultRouter };

export type AppRouter = typeof router;
