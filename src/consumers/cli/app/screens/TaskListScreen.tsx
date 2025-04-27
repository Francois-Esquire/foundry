import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useNavigate } from "react-router";

import { CreateButton } from "../components/CreateButton";
import { ListTasks } from "../components/ListTasks";
import { PageFooter } from "../components/PageFooter";
import { PageHeader } from "../components/PageHeader";
import { useAppStore } from "../store";
import { theme } from "../theme";

export function TaskListScreen() {
  const navigate = useNavigate();
  const { tasks } = useAppStore();

  // Determine whether we're focused on create button or task list
  const [focusCreate, setFocusCreate] = useState(tasks.length === 0);

  // Handle keyboard navigation between create button and task list
  useInput((input, key) => {
    if (tasks.length > 0) {
      if (key.upArrow && !focusCreate) {
        setFocusCreate(true);
      } else if (key.downArrow && focusCreate) {
        setFocusCreate(false);
      }
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <PageHeader
        title={`Tasks`}
        showBackButton={true}
        onBack={() => navigate("/products")}
      />

      <CreateButton
        label="➕ Create new task"
        onClick={() => navigate("/tasks/create")}
        isFocused={focusCreate}
      />

      <ListTasks
        tasks={tasks}
        onSelectTask={(id) => navigate(`/tasks/${id}`)}
        isActive={!focusCreate}
      />

      <PageFooter
        helpText={
          tasks.length > 0
            ? "(Use ↑/↓ to navigate, Enter to select, Esc to go back)"
            : "(Press Enter to create a new task, Esc to go back)"
        }
      />
    </Box>
  );
}
