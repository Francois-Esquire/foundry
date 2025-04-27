import React from "react";
import { Box, Text, useInput } from "ink";
import { useNavigate, useParams } from "react-router";

import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { useAppStore } from "../store";

export function TaskScreen() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { getTaskById, getProductById } = useAppStore((state) => ({
    getTaskById: (taskId: string) =>
      state.tasks.find((task) => task.id === taskId),
    getProductById: (productId: string) =>
      state.products.find((prod) => prod.id === productId),
  }));

  const task = getTaskById(id || "");
  const product = task?.productId ? getProductById(task.productId) : undefined;

  useInput((input, key) => {
    if (key.escape) {
      navigate("/tasks");
    }
  });

  if (!task) {
    return (
      <Box padding={1}>
        <Text color="red">Task not found!</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <PageHeader
        title={`Task: ${task.title}`}
        showBackButton={true}
        onBack={() => navigate("/tasks")} // Adjust as needed
      />

      <Box flexDirection="column" gap={1} marginTop={1}>
        <Box>
          <Box width={15}>
            <Text bold>Status:</Text>
          </Box>
          <StatusBadge status={task.status} />
        </Box>
        {task.priority && (
          <Box>
            <Box width={15}>
              <Text bold>Priority:</Text>
            </Box>
            <Text>{task.priority}</Text>
          </Box>
        )}
        {product && (
          <Box>
            <Box width={15}>
              <Text bold>Product:</Text>
            </Box>
            <Text color="cyan">{product.name}</Text>{" "}
            {/* Add link/navigation later */}
          </Box>
        )}
        {task.description && (
          <Box flexDirection="column">
            <Text bold>Description:</Text>
            <Text wrap="wrap">{task.description}</Text>
          </Box>
        )}
        {task.dependencies && task.dependencies.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Dependencies:</Text>
            {task.dependencies.map((depId) => (
              <Text key={depId}>
                {" "}
                - {depId} {/* Maybe show task title? */}
              </Text>
            ))}
          </Box>
        )}

        {task.subtasks && task.subtasks.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Subtasks:</Text>
            {task.subtasks.map((sub) => (
              <Box key={sub.id} marginLeft={2} gap={1}>
                <StatusBadge status={sub.status} />
                <Text>{sub.title}</Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Press Esc to go back.</Text>
        {/* Add Edit/Delete prompts later */}
      </Box>
    </Box>
  );
}
