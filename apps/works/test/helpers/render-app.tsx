import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { useEffect } from "react";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { Shell } from "~/app/layout/shell";
import { WorksRoutes } from "~/app/routes";
import { ThemeProvider } from "~/app/theme/theme";

function LocationProbe({ onLocation }: { onLocation: (to: string) => void }) {
  const { pathname, search } = useLocation();
  useEffect(() => {
    onLocation(`${pathname}${search}`);
  }, [onLocation, pathname, search]);
  return null;
}

export function renderApp(
  path: string,
  options: { onLocation?: (to: string) => void } = {}
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      {
        element: (
          <>
            {options.onLocation && (
              <LocationProbe onLocation={options.onLocation} />
            )}
            <Shell>
              <WorksRoutes />
            </Shell>
          </>
        ),
        path: "*",
      },
    ],
    { initialEntries: [path] }
  );
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <RouterProvider router={router} />
      </ThemeProvider>
    </QueryClientProvider>
  );
  return { ...rendered, router };
}
