import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createHashRouter, RouterProvider } from "react-router";
import { worksRouteObjects } from "~/app/routes";
import { applyStoredTheme, ThemeProvider } from "~/app/theme/theme";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("index.html has no #root element");
}

// Before the root, not inside it: the document is themed before React paints.
applyStoredTheme();

const queryClient = new QueryClient();
// Hash routing: the packaged renderer is a file:// document.
const router = createHashRouter(worksRouteObjects());

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <RouterProvider router={router} />
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>
);
