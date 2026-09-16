import { defineConfig } from "blume";

export default defineConfig({
  content: {
    include: ["index.md", "quirks/**/*.md", "quirks/**/*.mdx"],
    root: "docs",
  },
  description: "Documentation for Foundry's local developer tools.",
  github: { owner: "Francois-Esquire", repo: "foundry" },
  title: "Foundry",
});
