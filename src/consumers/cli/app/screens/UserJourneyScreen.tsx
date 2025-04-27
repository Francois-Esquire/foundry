import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useNavigate } from "react-router";

import type { EdgeData, NodeData } from "../components/Graph";

import { AdaptiveGraphLayout } from "../components/AdaptiveGraphLayout";
import { Button } from "../components/Button";
import { Graph } from "../components/Graph";
import { PageFooter } from "../components/PageFooter";
import { PageHeader } from "../components/PageHeader";
import { Section } from "../components/Section";
import { useTerminalDimensions } from "../hooks/useTerminalDimensions";
import { useAppStore } from "../store";
import { theme } from "../theme";

// Define default journey phases
const defaultJourneyPhases: NodeData[] = [
  {
    id: "discovery",
    label: "Discovery",
    description: "Initial research and requirements gathering",
    status: "done",
  },
  {
    id: "planning",
    label: "Planning",
    description: "Project planning and task breakdown",
    status: "in-progress",
  },
  {
    id: "development",
    label: "Development",
    description: "Main implementation phase",
    status: "pending",
  },
  {
    id: "testing",
    label: "Testing",
    description: "Quality assurance and testing",
    status: "pending",
  },
  {
    id: "deployment",
    label: "Deployment",
    description: "Release and deployment",
    status: "pending",
  },
  {
    id: "maintenance",
    label: "Maintenance",
    description: "Ongoing maintenance and updates",
    status: "pending",
  },
];

// Define default connections between phases
const defaultJourneyEdges: EdgeData[] = [
  { from: "discovery", to: "planning", type: "sequence" },
  { from: "planning", to: "development", type: "sequence" },
  { from: "development", to: "testing", type: "sequence" },
  { from: "testing", to: "deployment", type: "sequence" },
  { from: "deployment", to: "maintenance", type: "sequence" },
];

export function UserJourneyScreen() {
  const navigate = useNavigate();
  const { tasks } = useAppStore();
  const dimensions = useTerminalDimensions();

  // State for the selected node/phase
  const [selectedPhaseId, setSelectedPhaseId] = useState<string | undefined>(
    defaultJourneyPhases[0]?.id,
  );
  const [currentLayout, setCurrentLayout] = useState<
    "horizontal" | "vertical" | "radial" | "auto"
  >("auto");

  // Focus state
  type FocusElement = "graph" | "layoutToggle" | "back";
  const [focusedElement, setFocusedElement] = useState<FocusElement>("graph");

  // Compute related tasks for the selected phase
  const getRelatedTasks = (phaseId: string) => {
    // In a real implementation, tasks would have a 'phase' property
    // For demo purposes, we're associating tasks to phases based on status
    const phaseTaskMap: Record<string, string[]> = {
      discovery: ["done"],
      planning: ["in-progress"],
      development: ["pending"],
      testing: [],
      deployment: [],
      maintenance: [],
    };

    const statuses = phaseTaskMap[phaseId] || [];
    return tasks.filter((task) => statuses.includes(task.status));
  };

  const relatedTasks = selectedPhaseId ? getRelatedTasks(selectedPhaseId) : [];

  // Get the effective layout based on terminal dimensions
  const getEffectiveLayout = (): "horizontal" | "vertical" | "radial" => {
    // Simple layout selection based on terminal dimensions
    const dimensions = useTerminalDimensions();

    // If user selected a specific layout, use that
    if (currentLayout !== "auto") return currentLayout;

    // Otherwise determine best layout
    if (dimensions.isWide) return "horizontal";
    if (dimensions.isTall) return "vertical";
    return "horizontal"; // Default to horizontal
  };

  const effectiveLayout = getEffectiveLayout();

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
        else if (focusedElement === "layoutToggle") setFocusedElement("graph");
        else if (focusedElement === "back") setFocusedElement("layoutToggle");
      } else {
        // Tab cycles forward
        if (focusedElement === "graph") setFocusedElement("layoutToggle");
        else if (focusedElement === "layoutToggle") setFocusedElement("back");
        else if (focusedElement === "back") setFocusedElement("graph");
      }
      return;
    }

    // Handle Enter key
    if (key.return) {
      if (focusedElement === "back") {
        navigate("/dashboard");
      } else if (focusedElement === "layoutToggle") {
        // Toggle layout
      }
      return;
    }

    // Arrow keys for layout toggle
    if (focusedElement === "layoutToggle") {
      if (key.rightArrow) {
        if (currentLayout === "auto") setCurrentLayout("horizontal");
        else if (currentLayout === "horizontal") setCurrentLayout("vertical");
        else if (currentLayout === "vertical") setCurrentLayout("radial");
        else setCurrentLayout("auto");
      } else if (key.leftArrow) {
        if (currentLayout === "auto") setCurrentLayout("radial");
        else if (currentLayout === "horizontal") setCurrentLayout("auto");
        else if (currentLayout === "vertical") setCurrentLayout("horizontal");
        else setCurrentLayout("vertical");
      }
    }

    // Arrow keys for graph navigation
    if (focusedElement === "graph") {
      if (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow) {
        const currentPhases = defaultJourneyPhases;
        const currentIndex = selectedPhaseId
          ? currentPhases.findIndex((phase) => phase.id === selectedPhaseId)
          : 0;

        let nextIndex = currentIndex;

        if (effectiveLayout === "horizontal") {
          // Horizontal layout navigation
          if (key.rightArrow) {
            nextIndex = Math.min(currentPhases.length - 1, currentIndex + 1);
          } else if (key.leftArrow) {
            nextIndex = Math.max(0, currentIndex - 1);
          }
        } else {
          // Vertical layout navigation
          if (key.downArrow) {
            nextIndex = Math.min(currentPhases.length - 1, currentIndex + 1);
          } else if (key.upArrow) {
            nextIndex = Math.max(0, currentIndex - 1);
          }
        }

        if (
          nextIndex !== currentIndex &&
          nextIndex >= 0 &&
          nextIndex < currentPhases.length
        ) {
          setSelectedPhaseId(currentPhases[nextIndex]?.id);
        }
      }
    }
  });

  return (
    <Box
      flexDirection="column"
      padding={theme.spacing.sm}
      gap={theme.spacing.md}
    >
      <PageHeader
        title="User Journey"
        showBackButton={true}
        onBack={() => navigate("/dashboard")}
      />

      <Section title="User Journey View Options">
        <Box flexDirection="row" gap={2}>
          <Button
            onPress={() => setCurrentLayout("auto")}
            isFocused={
              focusedElement === "layoutToggle" && currentLayout === "auto"
            }
          >
            Auto Layout
          </Button>
          <Button
            onPress={() => setCurrentLayout("horizontal")}
            isFocused={
              focusedElement === "layoutToggle" &&
              currentLayout === "horizontal"
            }
          >
            Horizontal
          </Button>
          <Button
            onPress={() => setCurrentLayout("vertical")}
            isFocused={
              focusedElement === "layoutToggle" && currentLayout === "vertical"
            }
          >
            Vertical
          </Button>
          <Button
            onPress={() => setCurrentLayout("radial")}
            isFocused={
              focusedElement === "layoutToggle" && currentLayout === "radial"
            }
          >
            Tree
          </Button>
        </Box>
      </Section>

      <Section title="Project Journey Phases">
        <Box>
          <AdaptiveGraphLayout
            nodes={defaultJourneyPhases}
            edges={defaultJourneyEdges}
            selectedNodeId={selectedPhaseId}
            onSelectNode={setSelectedPhaseId}
            title="Project Journey Phases"
            forceLayout={currentLayout}
          />
        </Box>
      </Section>

      {selectedPhaseId && (
        <Section
          title={`Phase: ${defaultJourneyPhases.find((p) => p.id === selectedPhaseId)?.label || "Unknown"}`}
        >
          <Box flexDirection="column" gap={1}>
            {(() => {
              const phase = defaultJourneyPhases.find(
                (p) => p.id === selectedPhaseId,
              );
              if (!phase) return <Text>Phase not found</Text>;

              return (
                <>
                  <Text bold>{phase.label}</Text>
                  <Text>{phase.description}</Text>
                  <Text>
                    Status:{" "}
                    <Text color={getStatusColor(phase.status || "pending")}>
                      {phase.status || "pending"}
                    </Text>
                  </Text>

                  <Box flexDirection="column" marginTop={1}>
                    <Text bold>Related Tasks ({relatedTasks.length}):</Text>
                    {relatedTasks.length > 0 ? (
                      relatedTasks
                        .slice(0, 5)
                        .map((task) => (
                          <Text key={task.id}>• {task.title}</Text>
                        ))
                    ) : (
                      <Text dimColor>No tasks found for this phase</Text>
                    )}
                    {relatedTasks.length > 5 && (
                      <Text dimColor>
                        ...and {relatedTasks.length - 5} more
                      </Text>
                    )}
                  </Box>
                </>
              );
            })()}
          </Box>
        </Section>
      )}

      <PageFooter
        helpText={
          "(Tab to navigate, ←/→ to change views, Enter to select, Esc to go back)"
        }
        isFocused={focusedElement === "back"}
        onBack={() => navigate("/dashboard")}
      />
    </Box>
  );
}

// Helper function to get color for status
const getStatusColor = (status: string): string => {
  switch (status.toLowerCase()) {
    case "done":
      return theme.colors.success;
    case "in-progress":
      return theme.colors.info;
    case "pending":
      return theme.colors.warning;
    case "cancelled":
      return theme.colors.error;
    default:
      return theme.colors.text;
  }
};
