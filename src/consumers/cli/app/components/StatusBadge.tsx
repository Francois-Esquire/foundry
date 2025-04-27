import React from "react";
import { Text } from "ink";

import type { TaskStatus } from "../store";

import { theme } from "../theme"; // Import theme

interface StatusBadgeProps {
  status: TaskStatus;
}

// Map status to theme colors
const statusColors: Record<TaskStatus, string> = {
  pending: theme.colors.warning,
  "in-progress": theme.colors.info,
  done: theme.colors.success,
  review: theme.colors.secondary,
  deferred: theme.colors.textDim,
  cancelled: theme.colors.error,
};

export function StatusBadge({ status }: StatusBadgeProps) {
  const color = statusColors[status] || theme.colors.text; // Use theme text color as default

  // Capitalize first letter for display
  const displayStatus = status.charAt(0).toUpperCase() + status.slice(1);

  return (
    <Text color={color} bold>
      [{displayStatus}]
    </Text>
  );
}
