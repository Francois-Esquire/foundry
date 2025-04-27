import type { ReactNode } from "react";

import React from "react";
import { Box } from "ink";

import { useTerminalDimensions } from "../hooks/useTerminalDimensions";

interface ResponsiveGraphProps {
  children: ReactNode;
  minWidth?: number;
  minHeight?: number;
  padding?: number;
}

export const ResponsiveGraph: React.FC<ResponsiveGraphProps> = ({
  children,
  minWidth = 80,
  minHeight = 20,
  padding = 2,
}) => {
  const { width, height, isWide, isTall } = useTerminalDimensions();

  // Calculate available space for the graph
  const availableWidth = Math.max(width - padding * 2, minWidth);
  const availableHeight = Math.max(height - padding * 2, minHeight);

  // Adjust layout based on terminal dimensions
  const flexDirection = isTall ? "column" : "row";

  return (
    <Box
      flexDirection={flexDirection}
      width={availableWidth}
      height={availableHeight}
      justifyContent="center"
      alignItems="center"
    >
      {children}
    </Box>
  );
};
