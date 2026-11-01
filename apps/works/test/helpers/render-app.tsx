import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { Shell } from "~/app/layout/shell";
import { WorksRoutes } from "~/app/routes";
import { ThemeProvider } from "~/app/theme/theme";

/** Reports every location the app navigates to, as `pathname?search`. */
function LocationProbe({ onLocation }: { onLocation: (to: string) => void }) {
  const { pathname, search } = useLocation();
  useEffect(() => {
    onLocation(`${pathname}${search}`);
  }, [onLocation, pathname, search]);
  return null;
}

/** The whole renderer at one route, as the window shows it. */
export function renderApp(
  path: string,
  options: { onLocation?: (to: string) => void } = {}
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[path]}>
          {options.onLocation && (
            <LocationProbe onLocation={options.onLocation} />
          )}
          <Shell>
            <WorksRoutes />
          </Shell>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
