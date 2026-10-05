import { defineConfig } from "blume";

export default defineConfig({
  content: {
    include: [
      "marbles/**/*.md",
      "marbles/**/*.mdx",
      "atlas/**/*.md",
      "atlas/**/*.mdx",
    ],
    root: ".",
  },
  deployment: {
    base: "/foundry",
    output: "static",
    site: "https://francois-esquire.github.io",
  },
  description: "Documentation for Foundry's local developer tools.",
  github: { owner: "Francois-Esquire", repo: "foundry" },
  navigation: {
    tabs: [
      { label: "Marbles", path: "/marbles" },
      { label: "Atlas", path: "/atlas" },
    ],
  },
  theme: {
    accent: "gray", // a named preset or any CSS color
    fonts: {
      body: "inter",
      // self-hosted Google Fonts
      display: "inter",
      mono: "ibm-plex-mono",
    },
    mode: "system", // system | light | dark
    radius: "md", // none | sm | md | lg
  },
  title: "Foundry",
});
