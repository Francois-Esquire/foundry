import React from "react";
import { Box, Text } from "ink";

import type { EdgeData, NodeData } from "./Graph";

import { useTerminalDimensions } from "../hooks/useTerminalDimensions";
import { theme } from "../theme";
import { Graph } from "./Graph";

interface AdaptiveGraphLayoutProps {
  nodes: NodeData[];
  edges: EdgeData[];
  selectedNodeId?: string;
  onSelectNode?: (id: string) => void;
  title?: string;
  forceLayout?: "horizontal" | "vertical" | "radial" | "auto";
  hideConnections?: boolean;
}

/**
 * A wrapper around the Graph component that adapts to the terminal dimensions
 * to provide the best possible layout
 */
export function AdaptiveGraphLayout({
  nodes,
  edges,
  selectedNodeId,
  onSelectNode,
  title,
  forceLayout = "auto",
  hideConnections = false,
}: AdaptiveGraphLayoutProps) {
  // Get terminal dimensions
  const dimensions = useTerminalDimensions();

  // Determine the best layout based on terminal dimensions
  const determineBestLayout = (): "horizontal" | "vertical" | "radial" => {
    if (forceLayout !== "auto") return forceLayout;

    // If we have a lot of nodes and a wide terminal, use horizontal
    if (nodes.length > 6 && dimensions.isWide) {
      return "horizontal";
    }

    // If we have a lot of nodes and a tall terminal, use vertical
    if (nodes.length > 6 && dimensions.isTall) {
      return "vertical";
    }

    // If we have a balanced terminal or fewer nodes, use radial
    if (nodes.length <= 6 || dimensions.aspectRatio >= 0.8) {
      return "radial";
    }

    // Default to horizontal for wide screens, vertical for narrow
    return dimensions.isWide ? "horizontal" : "vertical";
  };

  // Calculate optimal width and height based on terminal dimensions
  const calculateDimensions = () => {
    const layout = determineBestLayout();

    // Default sizing
    let width = Math.min(dimensions.width - 4, 120); // Max width with padding
    let height: number;

    if (layout === "horizontal") {
      // For horizontal layout, we need more width than height
      height = Math.min(Math.floor(nodes.length * 3), dimensions.height - 4);
    } else if (layout === "vertical") {
      // For vertical layout, we need more height than width
      height = Math.min(Math.floor(nodes.length * 3), dimensions.height - 4);
      width = Math.min(Math.floor(width * 0.8), 80); // Reduce width for vertical
    } else {
      // For radial layout, we want a balanced aspect ratio
      height = Math.min(Math.floor(nodes.length * 2.5), dimensions.height - 4);
    }

    // Ensure minimum dimensions
    return {
      width: Math.max(width, 40),
      height: Math.max(height, 10),
    };
  };

  const layout = determineBestLayout();
  const { width, height } = calculateDimensions();

  // Split nodes into rows based on layout
  const renderGraphInColumns = () => {
    if (nodes.length <= 4 || layout !== "horizontal") return null;

    // Only use multi-column for horizontal layout with enough nodes
    const halfLength = Math.ceil(nodes.length / 2);
    const firstHalf = nodes.slice(0, halfLength);
    const secondHalf = nodes.slice(halfLength);

    // Create edges for each half
    const firstHalfEdges = edges.filter(
      (edge) =>
        firstHalf.some((node) => node.id === edge.from) &&
        firstHalf.some((node) => node.id === edge.to),
    );

    const secondHalfEdges = edges.filter(
      (edge) =>
        secondHalf.some((node) => node.id === edge.from) &&
        secondHalf.some((node) => node.id === edge.to),
    );

    // Calculate connecting edges between columns
    const connectingEdges = edges.filter(
      (edge) =>
        (firstHalf.some((node) => node.id === edge.from) &&
          secondHalf.some((node) => node.id === edge.to)) ||
        (secondHalf.some((node) => node.id === edge.from) &&
          firstHalf.some((node) => node.id === edge.to)),
    );

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Box width="48%">
            <Graph
              nodes={firstHalf}
              edges={firstHalfEdges}
              selectedNodeId={selectedNodeId}
              onSelectNode={onSelectNode}
              layout="vertical"
              width={Math.floor(width * 0.45)}
              height={Math.min(firstHalf.length * 4, height)}
            />
          </Box>

          {/* Connector section */}
          {!hideConnections && connectingEdges.length > 0 && (
            <Box width="4%" alignItems="center" justifyContent="center">
              <Text color={theme.colors.border}>
                {connectingEdges.length > 0 ? "⟷" : " "}
              </Text>
            </Box>
          )}

          <Box width="48%">
            <Graph
              nodes={secondHalf}
              edges={secondHalfEdges}
              selectedNodeId={selectedNodeId}
              onSelectNode={onSelectNode}
              layout="vertical"
              width={Math.floor(width * 0.45)}
              height={Math.min(secondHalf.length * 4, height)}
            />
          </Box>
        </Box>

        {/* Show connecting edges summary */}
        {!hideConnections && connectingEdges.length > 0 && (
          <Box
            marginTop={1}
            borderStyle="round"
            borderColor={theme.colors.border}
            paddingX={1}
          >
            <Text dimColor>
              Connections between columns: {connectingEdges.length}{" "}
              {connectingEdges.length === 1 ? "edge" : "edges"}
            </Text>
          </Box>
        )}
      </Box>
    );
  };

  // If we can render in multiple columns, do that
  const columnLayout = renderGraphInColumns();
  if (columnLayout) {
    return (
      <Box flexDirection="column" width={width}>
        {title && (
          <Box marginBottom={1}>
            <Text bold>{title}</Text>
          </Box>
        )}
        {columnLayout}
      </Box>
    );
  }

  // Otherwise render as a single graph
  return (
    <Box flexDirection="column" width={width}>
      {title && (
        <Box marginBottom={1}>
          <Text bold>{title}</Text>
        </Box>
      )}
      <Box>
        <Graph
          nodes={nodes}
          edges={edges}
          layout={layout}
          selectedNodeId={selectedNodeId}
          onSelectNode={onSelectNode}
          width={width}
          height={height}
        />
      </Box>
    </Box>
  );
}
