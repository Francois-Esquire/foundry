import { fileURLToPath } from "node:url";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";

export default defineConfig({
  integrations: [
    react(),
    {
      hooks: {
        "astro:config:setup": ({ command, config, updateConfig }) => {
          // Astro check optimizes production React; it must not replace dev's JSX runtime.
          updateConfig({
            vite: {
              cacheDir: fileURLToPath(
                new URL(`vite/${command}/`, config.cacheDir)
              ),
            },
          });
        },
      },
      name: "isolated-vite-cache",
    },
  ],
  output: "static",
  site: "https://foundry.sh",
  trailingSlash: "always",
});
