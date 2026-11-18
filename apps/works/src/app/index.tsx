import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router";
import { Shell } from "~/app/layout/shell";
import { WorksRoutes } from "~/app/routes";
import { applyStoredTheme, ThemeProvider } from "~/app/theme/theme";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("index.html has no #root element");
}

applyStoredTheme();

const queryClient = new QueryClient();

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <HashRouter>
          <Shell>
            <WorksRoutes />
          </Shell>
        </HashRouter>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>
);
