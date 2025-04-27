import React from "react";
import { Box, Text, useInput } from "ink";
import { useNavigate, useParams } from "react-router";

import { CreateButton } from "../components/CreateButton";
import { ListTasks } from "../components/ListTasks";
import { PageHeader } from "../components/PageHeader";
import { useAppStore } from "../store";

export function ProductScreen() {
  const { id: productId } = useParams();
  const navigate = useNavigate();

  const { getProductById, getTasksByProductId } = useAppStore((state) => ({
    getProductById: (id: string) => state.products.find((p) => p.id === id),
    getTasksByProductId: (prodId: string) =>
      state.tasks.filter((task) => task.productId === prodId),
  }));

  const product = getProductById(productId || "");
  const productTasks = productId ? getTasksByProductId(productId) : [];

  const [focusCreateTask, setFocusCreateTask] = React.useState(
    productTasks.length === 0,
  );

  useInput((input, key) => {
    if (key.escape) {
      navigate("/products");
    }
    if (productTasks.length > 0) {
      if (key.upArrow && !focusCreateTask) {
        setFocusCreateTask(true);
      }
      if (key.downArrow && focusCreateTask) {
        setFocusCreateTask(false);
      }
    }
  });

  if (!product) {
    return (
      <Box padding={1}>
        <Text color="red">Product not found!</Text>
      </Box>
    );
  }

  const handleCreateTask = () => {
    navigate(`/tasks/create?productId=${productId}`);
  };

  return (
    <Box flexDirection="column" padding={1}>
      <PageHeader
        title={`Product: ${product.name}`}
        showBackButton
        onBack={() => navigate("/products")}
      />

      <Box
        flexDirection="column"
        gap={1}
        marginY={1}
        paddingX={1}
        borderStyle="round"
      >
        <Text bold>Details</Text>
        {product.description && <Text>Description: {product.description}</Text>}
        <Text>Created: {product.createdAt.toLocaleDateString()}</Text>
      </Box>

      <Box flexDirection="column" gap={1} marginY={1}>
        <Text bold>Tasks for this Product</Text>
        <CreateButton
          label="➕ Create new task for this product"
          onClick={handleCreateTask}
          isFocused={focusCreateTask}
        />
        <ListTasks
          tasks={productTasks}
          onSelectTask={(taskId) => navigate(`/tasks/${taskId}`)}
          isActive={!focusCreateTask}
        />
        {productTasks.length === 0 && (
          <Box marginTop={1}>
            <Text dimColor>No tasks associated with this product yet.</Text>
          </Box>
        )}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Press Esc to go back.</Text>
      </Box>
    </Box>
  );
}
