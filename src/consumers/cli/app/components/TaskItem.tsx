import React from "react";
import { Box, Text } from "ink";

import type { Task } from "../store";

interface TaskItemProps {
  task: Task;
  isFocused: boolean;
}

// Get color based on task status
function getStatusColor(status: Task["status"]): string {
  switch (status) {
    case "pending":
      return "yellow";
    case "in-progress":
      return "blue";
    case "done":
      return "green";
    case "review":
      return "orange";
    case "deferred":
      return "gray";
    case "cancelled":
      return "red";
    default:
      return "white";
  }
}

// Get emoji based on task status
function getStatusEmoji(status: Task["status"]): string {
  switch (status) {
    case "pending":
      return "⏳";
    case "in-progress":
      return "🔄";
    case "done":
      return "✅";
    case "review":
      return "🔍";
    case "deferred":
      return "⏰";
    case "cancelled":
      return "❌";
    default:
      return "⬜";
  }
}

export function TaskItem({ task, isFocused }: TaskItemProps) {
  const statusColor = getStatusColor(task.status);
  const statusEmoji = getStatusEmoji(task.status);

  return (
    <Box flexDirection="column" marginY={0.5}>
      <Box>
        <Text color={isFocused ? "green" : undefined}>
          {isFocused ? "› " : "  "}
          <Text bold>{task.title}</Text>{" "}
          <Text color={statusColor}>
            {statusEmoji} {task.status}
          </Text>
        </Text>
      </Box>

      {task.description && (
        <Box paddingLeft={isFocused ? 2 : 4}>
          <Text dimColor>
            {task.description.substring(0, 60)}
            {task.description.length > 60 ? "..." : ""}
          </Text>
        </Box>
      )}
    </Box>
  );
}
