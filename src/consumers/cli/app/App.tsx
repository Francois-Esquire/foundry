import React from "react";
import {
  defaultTheme,
  extendTheme,
  ThemeProvider,
  // useComponentTheme,
} from "@inkjs/ui";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";

import { ScreenLayout } from "./layouts/ScreenLayout";
import { AnalyzeProjectScreen } from "./screens/AnalyzeProjectScreen";
import { ConfigureScreen } from "./screens/ConfigureScreen";
import { CreateProductScreen } from "./screens/CreateProductScreen";
import { CreateTaskScreen } from "./screens/CreateTaskScreen";
import { DashboardScreen } from "./screens/DashboardScreen";
import { NotFoundScreen } from "./screens/NotFound";
import { ProductListScreen } from "./screens/ProductListScreen";
import { ProductScreen } from "./screens/ProductScreen";
import { TaskListScreen } from "./screens/TaskListScreen";
import { TaskScreen } from "./screens/TaskScreen";
import { WelcomeScreen } from "./screens/WelcomeScreen";

const theme = extendTheme(defaultTheme, {
  components: {
    Button: {},
  },
});

export function App() {
  // Render the current screen
  return (
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<WelcomeScreen />} />
          <Route
            element={
              <ScreenLayout>
                <Outlet />
              </ScreenLayout>
            }
          >
            <Route path="/dashboard" element={<DashboardScreen />} />
            <Route path="/products" element={<ProductListScreen />} />
            <Route path="/products/create" element={<CreateProductScreen />} />
            <Route path="/products/:id" element={<ProductScreen />} />
            <Route path="/tasks" element={<TaskListScreen />} />
            <Route path="/tasks/create" element={<CreateTaskScreen />} />
            <Route path="/tasks/:id" element={<TaskScreen />} />
            <Route
              path="/jobs/analyze-project"
              element={<AnalyzeProjectScreen />}
            />
            <Route path="/configure" element={<ConfigureScreen />} />

            <Route path="*" element={<NotFoundScreen />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </ThemeProvider>
  );
}
