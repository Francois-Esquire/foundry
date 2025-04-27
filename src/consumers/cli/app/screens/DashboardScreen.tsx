import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useNavigate } from "react-router";

import { Button } from "../components/Button";
import { Section } from "../components/Section";
import { StatusBadge } from "../components/StatusBadge";
import { useAppStore } from "../store";
import { theme } from "../theme";

const MAX_ITEMS_DISPLAY = 3;

// Define focusable elements on the dashboard
type FocusableElement =
  | "newProduct"
  | "analyzeProject"
  | "getNextTask"
  | "viewAllProducts"
  | "viewAllTasks";

export function DashboardScreen() {
  const navigate = useNavigate();
  const { products, tasks } = useAppStore();

  const displayProducts = products.slice(0, MAX_ITEMS_DISPLAY);
  const displayTasks = tasks.slice(0, MAX_ITEMS_DISPLAY);

  const showViewAllProducts = products.length > MAX_ITEMS_DISPLAY;
  const showViewAllTasks = tasks.length > MAX_ITEMS_DISPLAY;

  // --- Focus State --- dynamically build focus order
  const focusOrder: FocusableElement[] = [
    "newProduct",
    "analyzeProject",
    "getNextTask",
    ...(showViewAllProducts ? ["viewAllProducts" as FocusableElement] : []),
    ...(showViewAllTasks ? ["viewAllTasks" as FocusableElement] : []),
  ];

  const [focusedElement, setFocusedElement] = useState<FocusableElement>(
    focusOrder[0] || "newProduct",
  );

  const handleGetNextTask = () => {
    console.log("Get Next Task clicked (not implemented)");
  };

  const actions: Record<FocusableElement, () => void> = {
    newProduct: () => navigate("/products/create"),
    analyzeProject: () => navigate("/jobs/analyze-project"),
    getNextTask: handleGetNextTask,
    viewAllProducts: () => navigate("/products"),
    viewAllTasks: () => navigate("/tasks"),
  };

  // --- Input Handling for Navigation ---
  useInput((input, key) => {
    if (focusOrder.length === 0) return;

    const currentIndex = focusOrder.indexOf(focusedElement);
    if (currentIndex === -1) return;

    let nextElement: FocusableElement | undefined;
    if (key.rightArrow || key.tab) {
      nextElement = focusOrder[(currentIndex + 1) % focusOrder.length];
    } else if (key.leftArrow) {
      nextElement =
        focusOrder[(currentIndex - 1 + focusOrder.length) % focusOrder.length];
    }
    if (nextElement) setFocusedElement(nextElement);
    else if (key.return) actions[focusedElement]?.();
  });

  // Calculate stats
  const totalProducts = products.length;
  const totalTasks = tasks.length;
  const pendingTasks = tasks.filter(
    (t) => t.status === "pending" || t.status === "in-progress",
  ).length;

  const headerLine = "-=".repeat(20);
  const headerText = "FOUNDRY DASHBOARD";

  return (
    <Box
      flexDirection="column"
      padding={theme.spacing.sm}
      gap={theme.spacing.md}
    >
      {/* Enhanced Header */}
      <Box
        flexDirection="column"
        alignItems="center"
        marginBottom={theme.spacing.sm}
      >
        <Text bold color={theme.colors.secondary}>
          {headerLine}
        </Text>
        <Box paddingX={theme.spacing.md}>
          <Text bold color={theme.colors.primary}>
            {headerText.toUpperCase()}
          </Text>
        </Box>
        <Text bold color={theme.colors.secondary}>
          {headerLine}
        </Text>
      </Box>
      {/* Status Overview Section */}
      <Section title="Project Status" gap={theme.spacing.xs}>
        <Box gap={theme.spacing.md}>
          <Text>
            Total Products:{" "}
            <Text bold color={theme.colors.primary}>
              {totalProducts}
            </Text>
          </Text>
          <Text>
            Total Tasks:{" "}
            <Text bold color={theme.colors.primary}>
              {totalTasks}
            </Text>
          </Text>
          <Text>
            Active/Pending Tasks:{" "}
            <Text bold color={theme.colors.warning}>
              {pendingTasks}
            </Text>
          </Text>
        </Box>
      </Section>
      {/* Quick Actions Section */}
      <Section title="Quick Actions" gap={theme.spacing.sm}>
        <Box gap={theme.spacing.sm} marginLeft={theme.spacing.sm}>
          <Button
            onPress={actions.newProduct}
            isFocused={focusedElement === "newProduct"}
          >
            New Product
          </Button>
          <Button
            onPress={actions.analyzeProject}
            isFocused={focusedElement === "analyzeProject"}
          >
            Analyze Project
          </Button>
          <Button
            onPress={actions.getNextTask}
            isFocused={focusedElement === "getNextTask"}
          >
            Get Next Task
          </Button>
        </Box>
      </Section>
      {/* Products Section */}
      <Section
        title={`Recent Products (${totalProducts} total)`}
        gap={theme.spacing.xs}
      >
        {displayProducts.length > 0 ? (
          displayProducts.map((product) => (
            <Box key={product.id} paddingLeft={theme.spacing.sm}>
              <Text>• {product.name}</Text>
            </Box>
          ))
        ) : (
          <Box paddingLeft={theme.spacing.sm}>
            <Text dimColor>No products found.</Text>
          </Box>
        )}
        {showViewAllProducts && (
          <Box paddingLeft={theme.spacing.sm} marginTop={theme.spacing.xs}>
            <Button
              onPress={actions.viewAllProducts}
              isFocused={focusedElement === "viewAllProducts"}
            >
              View All Products...
            </Button>
          </Box>
        )}
      </Section>
      {/* Tasks Section */}
      <Section
        title={`Recent Tasks (${totalTasks} total)`}
        gap={theme.spacing.xs}
      >
        {displayTasks.length > 0 ? (
          displayTasks.map((task) => (
            <Box key={task.id} paddingLeft={theme.spacing.sm} gap={1}>
              <StatusBadge status={task.status} />
              <Text>{task.title}</Text>
            </Box>
          ))
        ) : (
          <Box paddingLeft={theme.spacing.sm}>
            <Text dimColor>No tasks found.</Text>
          </Box>
        )}
        {showViewAllTasks && (
          <Box paddingLeft={theme.spacing.sm} marginTop={theme.spacing.xs}>
            <Button
              onPress={actions.viewAllTasks}
              isFocused={focusedElement === "viewAllTasks"}
            >
              View All Tasks...
            </Button>
          </Box>
        )}
      </Section>
      {/* Footer Help Text */}
      <Section borderStyle="none" center={true}>
        <Text dimColor>
          (Use ← → or Tab to navigate actions, Enter to select)
        </Text>
      </Section>
    </Box>
  );
}
