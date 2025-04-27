import React from "react";
import { Box, Text } from "ink";

import { theme } from "../theme";

// Define types for the graph components
export type NodeId = string;

export interface NodeData {
  id: NodeId;
  label: string;
  description?: string;
  status?: string;
  meta?: Record<string, any>;
}

export interface EdgeData {
  from: NodeId;
  to: NodeId;
  label?: string;
  type?: "dependency" | "sequence" | "relation";
}

export interface GraphProps {
  nodes: NodeData[];
  edges: EdgeData[];
  selectedNodeId?: NodeId;
  onSelectNode?: (id: NodeId) => void;
  layout?: "horizontal" | "vertical" | "radial";
  width?: number;
  height?: number;
}

// Box-drawing characters for edges
const horizontalLine = "─";
const verticalLine = "│";
const _topRightCorner = "┌";
const _topLeftCorner = "┐";
const _bottomRightCorner = "└";
const _bottomLeftCorner = "┘";
const _crossHorizontal = "┼";
const _teeUp = "┴";
const _teeDown = "┬";
const teeRight = "├";
const _teeLeft = "┤";
const arrowRight = "→";
const _arrowLeft = "←";
const _arrowUp = "↑";
const arrowDown = "↓";

/**
 * A node component for displaying in the graph
 */
export const Node: React.FC<{
  data: NodeData;
  isSelected?: boolean;
  onClick?: () => void;
}> = ({ data, isSelected = false, onClick: _onClick }) => {
  const { label, description, status } = data;

  // Calculate minimum height based on content
  const hasDescription = Boolean(description);
  const hasStatus = Boolean(status);
  const minHeight = 1 + (hasDescription ? 1 : 0) + (hasStatus ? 1 : 0);

  return (
    <Box
      flexDirection="column"
      paddingX={1}
      paddingY={0.5}
      borderStyle="round"
      borderColor={isSelected ? theme.colors.primary : theme.colors.border}
      // Use background color conditionally
      {...(isSelected ? { backgroundColor: "blue" } : {})}
      minHeight={minHeight}
      height={minHeight}
    >
      <Text bold color={isSelected ? theme.colors.primary : undefined}>
        {label}
      </Text>
      {description && (
        <Text wrap="truncate" dimColor={!isSelected}>
          {description.length > 20
            ? `${description.substring(0, 20)}...`
            : description}
        </Text>
      )}
      {status && <Text color={getStatusColor(status)}>Status: {status}</Text>}

      {/* If we need to pad with empty lines to meet min height */}
      {minHeight > 1 + (hasDescription ? 1 : 0) + (hasStatus ? 1 : 0) && (
        <Box
          height={
            minHeight - 1 - (hasDescription ? 1 : 0) - (hasStatus ? 1 : 0)
          }
        />
      )}
    </Box>
  );
};

/**
 * A simple edge component to connect nodes
 */
export const Edge: React.FC<{
  from: { x: number; y: number };
  to: { x: number; y: number };
  label?: string;
  type?: "dependency" | "sequence" | "relation";
}> = (_props) => {
  // For CLI, we'll use a very simple edge representation
  // The actual rendering is done by the Graph component
  return null;
};

/**
 * Simple helper to get a color for a status
 */
const getStatusColor = (status: string): string => {
  switch (status.toLowerCase()) {
    case "pending":
      return theme.colors.warning;
    case "in-progress":
      return theme.colors.info;
    case "done":
      return theme.colors.success;
    case "cancelled":
      return theme.colors.error;
    default:
      return theme.colors.text;
  }
};

/**
 * Main Graph component
 * Renders nodes and edges in a terminal-friendly layout
 */
export const Graph: React.FC<GraphProps> = ({
  nodes,
  edges,
  selectedNodeId,
  onSelectNode,
  layout = "horizontal",
  width = 60,
  height = 20,
}) => {
  // For simplicity in CLI, we'll render a list-based view with connections
  // This is much easier to render in a terminal than a true graph layout

  return (
    <Box flexDirection="column" width={width} height={height}>
      {layout === "horizontal" ? (
        // Horizontal layout (left to right)
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {nodes.map((node, index) => {
            const isSelected = node.id === selectedNodeId;
            const hasOutgoing = edges.some((e) => e.from === node.id);
            const _hasIncoming = edges.some((e) => e.to === node.id);

            return (
              <Box key={node.id} flexDirection="row" alignItems="center">
                <Node
                  data={node}
                  isSelected={isSelected}
                  onClick={() => onSelectNode?.(node.id)}
                />
                {index < nodes.length - 1 && hasOutgoing && (
                  <Text color={theme.colors.border}>
                    {" "}
                    {horizontalLine}
                    {horizontalLine}
                    {arrowRight}{" "}
                  </Text>
                )}
              </Box>
            );
          })}
        </Box>
      ) : layout === "vertical" ? (
        // Vertical layout (top to bottom)
        <Box flexDirection="column" gap={0}>
          {nodes.map((node, index) => {
            const isSelected = node.id === selectedNodeId;
            const hasOutgoing = edges.some((e) => e.from === node.id);

            return (
              <Box key={node.id} flexDirection="column" alignItems="center">
                <Node
                  data={node}
                  isSelected={isSelected}
                  onClick={() => onSelectNode?.(node.id)}
                />
                {index < nodes.length - 1 && hasOutgoing && (
                  <Text color={theme.colors.border}>
                    {verticalLine}
                    {arrowDown}
                  </Text>
                )}
              </Box>
            );
          })}
        </Box>
      ) : (
        // Radial/tree layout is complex in CLI, so we'll use a list with indentation
        <Box flexDirection="column">
          {nodes.map((node) => {
            const isSelected = node.id === selectedNodeId;
            const level = getNodeLevel(node.id, edges);
            const indent = " ".repeat(level * 2);

            return (
              <Box key={node.id} flexDirection="row">
                <Text>{indent}</Text>
                {level > 0 && (
                  <Text color={theme.colors.border}>
                    {teeRight}
                    {horizontalLine}{" "}
                  </Text>
                )}
                <Node
                  data={node}
                  isSelected={isSelected}
                  onClick={() => onSelectNode?.(node.id)}
                />
              </Box>
            );
          })}
        </Box>
      )}

      {/* Optional: Display edge information */}
      <Box marginTop={1} flexDirection="column">
        {edges.length > 0 && (
          <Box flexDirection="column" borderStyle="round" borderColor="gray">
            <Text dimColor bold>
              Connections:
            </Text>
            {edges.slice(0, 5).map((edge, i) => {
              const fromNode = nodes.find((n) => n.id === edge.from);
              const toNode = nodes.find((n) => n.id === edge.to);
              return (
                <Text key={i} dimColor>
                  {fromNode?.label} {arrowRight} {toNode?.label}
                  {edge.label ? ` (${edge.label})` : ""}
                </Text>
              );
            })}
            {edges.length > 5 && (
              <Text dimColor>...and {edges.length - 5} more</Text>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
};

/**
 * Helper function to determine the level of a node in a tree
 */
const getNodeLevel = (nodeId: NodeId, edges: EdgeData[]): number => {
  // Find the path length to root (node without incoming edges)
  const incomingEdge = edges.find((e) => e.to === nodeId);
  if (!incomingEdge) return 0; // Root node

  // Recursively get the level of the parent
  return 1 + getNodeLevel(incomingEdge.from, edges);
};
