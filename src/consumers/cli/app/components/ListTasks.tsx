import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

import type { Task } from "../store";

import { TaskItem } from "./TaskItem";

interface ListTasksProps {
  tasks: Task[];
  onSelectTask: (_id: string) => void;
  isActive: boolean;
}

export function ListTasks({ tasks, onSelectTask, isActive }: ListTasksProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Early return if no tasks
  if (tasks.length === 0) {
    return (
      <Box marginY={1}>
        <Text dimColor>No tasks found.</Text>
      </Box>
    );
  }

  // Handle keyboard input for navigation
  useInput((input, key) => {
    if (!isActive) return;

    if (key.upArrow) {
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev));
    } else if (key.downArrow) {
      setSelectedIndex((prev) => (prev < tasks.length - 1 ? prev + 1 : prev));
    } else if (key.return) {
      // Safety check
      if (
        tasks.length > 0 &&
        selectedIndex >= 0 &&
        selectedIndex < tasks.length
      ) {
        const selectedTask = tasks[selectedIndex];
        if (selectedTask) {
          onSelectTask(selectedTask.id);
        }
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Box marginY={1}>
        <Text>Tasks ({tasks.length}):</Text>
      </Box>

      <Box flexDirection="column">
        {tasks.map((task, index) => (
          <TaskItem
            key={task.id}
            task={task}
            isFocused={isActive && selectedIndex === index}
          />
        ))}
      </Box>
    </Box>
  );
}
