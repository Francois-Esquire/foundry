import { defineStories, story } from "textbook-sh";
import { CatalogLayout } from "~/components/layouts/catalog";
import { theme } from "~/components/ui/theme";
import { renderFrame } from "../frame";
import { Slot } from "./slot";

const catalog = (
  <Slot
    detail="Triggers above marbles"
    label="catalog"
    tone={theme.colors.accent}
  />
);

const details = (
  <Slot
    detail="The selected item's details"
    label="details"
    tone={theme.colors.primary}
  />
);

export default defineStories({
  component: "CatalogLayout",
  description:
    "The catalog with optional details beside it, split two parts to three.",
  title: "Layouts/Catalog",
});

export const WithDetails = story({
  description: "Details open beside the catalog at 120 columns.",
  name: "With details · wide",
  render: (renderer) =>
    renderFrame(
      renderer,
      <CatalogLayout catalog={catalog} details={details} />,
      { height: 16, width: 120 }
    ),
});

export const WithDetailsNarrow = story({
  description: "The same two-to-three split at 60 columns.",
  name: "With details · narrow",
  render: (renderer) =>
    renderFrame(
      renderer,
      <CatalogLayout catalog={catalog} details={details} />,
      { height: 16, width: 60 }
    ),
});

export const CatalogOnly = story({
  description: "Without details the catalog takes the whole region.",
  name: "Catalog only",
  render: (renderer) =>
    renderFrame(renderer, <CatalogLayout catalog={catalog} />, {
      height: 16,
      width: 120,
    }),
});
