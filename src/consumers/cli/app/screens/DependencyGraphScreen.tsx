import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useNavigate } from "react-router";

import type { EdgeData, NodeData } from "../components/Graph";

import { AdaptiveGraphLayout } from "../components/AdaptiveGraphLayout";
import { Button } from "../components/Button";
import { PageFooter } from "../components/PageFooter";
import { PageHeader } from "../components/PageHeader";
import { Section } from "../components/Section";
import { useAppStore } from "../store";
import { theme } from "../theme";

// TODO: Implement Dependency Graph Screen

export function DependencyGraphScreen() {
  const navigate = useNavigate();
  const { tasks } = useAppStore();

  // State for the selected node/task
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(
    undefined,
  );
  const [currentViewMode, setCurrentViewMode] = useState<
    "all" | "pending" | "blocked"
  >("all");
  const [layoutType, setLayoutType] = useState<
    "horizontal" | "vertical" | "radial" | "auto"
  >("auto");

  // Track which UI element has focus
  type FocusElement = "graph" | "viewMode" | "layout" | "back";
  const [focusedElement, setFocusedElement] = useState<FocusElement>("graph");

  // Convert tasks to graph nodes and edges
  const convertTasksToGraph = () => {
    // Filter tasks based on the current view mode
    const filteredTasks = tasks.filter((task) => {
      if (currentViewMode === "all") return true;
      if (currentViewMode === "pending")
        return task.status === "pending" || task.status === "in-progress";
      if (currentViewMode === "blocked") {
        // Check if any dependencies are not done
        if (!task.dependencies || task.dependencies.length === 0) return false;
        return task.dependencies.some((depId) => {
          const depTask = tasks.find((t) => t.id === depId);
          return depTask && depTask.status !== "done";
        });
      }
      return true;
    });

    // Create nodes from filtered tasks
    const nodes: NodeData[] = filteredTasks.map((task) => ({
      id: task.id,
      label: task.title,
      description: task.description,
      status: task.status,
      meta: { productId: task.productId },
    }));

    // Create edges from dependencies
    const edges: EdgeData[] = [];
    filteredTasks.forEach((task) => {
      if (task.dependencies && task.dependencies.length > 0) {
        task.dependencies.forEach((depId) => {
          // Only add edge if the dependent task is in our filtered set
          if (filteredTasks.some((t) => t.id === depId)) {
            edges.push({
              from: depId,
              to: task.id,
              type: "dependency",
            });
          }
        });
      }
    });

    return { nodes, edges };
  };

  const { nodes, edges } = convertTasksToGraph();

  // Handle keyboard input
  useInput((input, key) => {
    if (key.escape) {
      navigate("/dashboard");
      return;
    }

    // Tab navigation between UI elements
    if (key.tab) {
      if (key.shift) {
        // Shift+Tab cycles backward
        if (focusedElement === "graph") setFocusedElement("back");
        else if (focusedElement === "viewMode") setFocusedElement("graph");
        else if (focusedElement === "layout") setFocusedElement("viewMode");
        else if (focusedElement === "back") setFocusedElement("layout");
      } else {
        // Tab cycles forward
        if (focusedElement === "graph") setFocusedElement("viewMode");
        else if (focusedElement === "viewMode") setFocusedElement("layout");
        else if (focusedElement === "layout") setFocusedElement("back");
        else if (focusedElement === "back") setFocusedElement("graph");
      }
      return;
    }

    // Handle Enter key for various UI elements
    if (key.return) {
      if (focusedElement === "back") {
        navigate("/dashboard");
      } else if (focusedElement === "graph" && selectedNodeId) {
        // Navigate to task details when Enter is pressed on a selected node
        navigate(`/tasks/${selectedNodeId}`);
      }
      return;
    }

    // Arrow keys for navigation within the focused element
    if (focusedElement === "viewMode") {
      if (key.rightArrow) {
        if (currentViewMode === "all") setCurrentViewMode("pending");
        else if (currentViewMode === "pending") setCurrentViewMode("blocked");
        else setCurrentViewMode("all");
      } else if (key.leftArrow) {
        if (currentViewMode === "all") setCurrentViewMode("blocked");
        else if (currentViewMode === "pending") setCurrentViewMode("all");
        else setCurrentViewMode("pending");
      }
    } else if (focusedElement === "layout") {
      if (key.rightArrow) {
        if (layoutType === "horizontal") setLayoutType("vertical");
        else if (layoutType === "vertical") setLayoutType("radial");
        else if (layoutType === "radial") setLayoutType("auto");
        else setLayoutType("horizontal");
      } else if (key.leftArrow) {
        if (layoutType === "horizontal") setLayoutType("auto");
        else if (layoutType === "vertical") setLayoutType("horizontal");
        else if (layoutType === "radial") setLayoutType("vertical");
        else setLayoutType("radial");
      }
    } else if (focusedElement === "graph" && nodes.length > 0) {
      // Graph navigation using arrow keys
      if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
        // Find current selected node index
        const currentIndex = selectedNodeId
          ? nodes.findIndex((n) => n.id === selectedNodeId)
          : -1;

        let nextIndex = 0;
        if (currentIndex === -1) {
          // No node selected yet, select first one
          nextIndex = 0;
        } else if (key.rightArrow || key.downArrow) {
          // Move to next node
          nextIndex = (currentIndex + 1) % nodes.length;
        } else {
          // Move to previous node
          nextIndex = (currentIndex - 1 + nodes.length) % nodes.length;
        }

        if (nodes.length > 0 && nodes[nextIndex]) {
          setSelectedNodeId(nodes[nextIndex]?.id);
        }
      }
    }
  });

  // When a node is selected
  const handleSelectNode = (id: string) => {
    setSelectedNodeId(id);
    // We'll use the Enter key to navigate to task details instead of auto-navigating
  };

  return (
    <Box
      flexDirection="column"
      padding={theme.spacing.sm}
      gap={theme.spacing.md}
    >
      <PageHeader
        title="Dependency Graph"
        showBackButton={true}
        onBack={() => navigate("/dashboard")}
      />

      <Box flexDirection="row" gap={2}>
        <Button onPress={() => setCurrentViewMode("all")}>All Tasks</Button>
        <Button onPress={() => setCurrentViewMode("pending")}>
          Pending Only
        </Button>
        <Button onPress={() => setCurrentViewMode("blocked")}>
          Blocked Tasks
        </Button>
      </Box>

      <Box flexDirection="row" gap={2}>
        <Button onPress={() => setLayoutType("horizontal")}>Horizontal</Button>
        <Button onPress={() => setLayoutType("vertical")}>Vertical</Button>
        <Button onPress={() => setLayoutType("radial")}>Tree</Button>
        <Button onPress={() => setLayoutType("auto")}>Auto</Button>
      </Box>

      <Section title={`Task Dependencies (${nodes.length} tasks)`}>
        {nodes.length > 0 ? (
          <Box borderStyle="round" paddingX={1} paddingY={1}>
            <AdaptiveGraphLayout
              nodes={nodes}
              edges={edges}
              forceLayout={layoutType}
              selectedNodeId={selectedNodeId}
              onSelectNode={handleSelectNode}
              title={`Task Dependencies (${nodes.length} tasks)`}
            />
          </Box>
        ) : (
          <Text dimColor>
            No tasks with dependencies found in the current view mode.
          </Text>
        )}
      </Section>

      {selectedNodeId && (
        <Section title="Selected Task">
          {(() => {
            const task = tasks.find((t) => t.id === selectedNodeId);
            if (!task) return <Text>Task not found</Text>;

            return (
              <Box flexDirection="column" gap={1}>
                <Text bold>{task.title}</Text>
                <Text>Status: {task.status}</Text>
                {task.description && (
                  <Text wrap="wrap">{task.description}</Text>
                )}
                <Text>
                  <Text bold>Dependencies:</Text>{" "}
                  {task.dependencies?.length || 0} tasks
                </Text>
                <Button onPress={() => navigate(`/tasks/${selectedNodeId}`)}>
                  View Details
                </Button>
              </Box>
            );
          })()}
        </Section>
      )}

      <Box justifyContent="center">
        <Button onPress={() => navigate("/dashboard")}>
          Back to Dashboard
        </Button>
      </Box>

      <PageFooter helpText="(Tab to navigate, ←/→ to change views, Enter to select, Esc to go back)" />
    </Box>
  );
}
