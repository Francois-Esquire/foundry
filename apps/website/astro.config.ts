import { fileURLToPath } from "node:url";
import react from "@astrojs/react";
import { wgslVitePlugin } from "@vgpu/wgsl/loader-vite";
import { defineConfig } from "astro/config";
import { noNodeBuiltins } from "../spyglass/scripts/no-node-builtins";

export default defineConfig({
  integrations: [
    react(),
    {
      hooks: {
        "astro:config:setup": ({ command, config, updateConfig }) => {
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
  vite: {
    plugins: [
      wgslVitePlugin(),

      {
        ...noNodeBuiltins(),
        applyToEnvironment: ({ name }) => name === "client",
      },
    ],
  },
});
