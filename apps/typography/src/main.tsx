import "~/ui/styles";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Root } from "~/app/root";
import { startTheme } from "~/ui/theme";

const root = document.getElementById("root");
if (!root) {
  throw new Error("index.html has no #root element to render into.");
}

startTheme();
createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>
);
