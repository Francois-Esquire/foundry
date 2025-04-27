import React, { useState } from "react";
import { Select, TextInput } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import { useNavigate } from "react-router";

import type { Task, TaskStatus } from "../store";

import { PageHeader } from "../components/PageHeader";
import { useAppStore } from "../store";

// Define options for Select components
const statusOptions: { label: string; value: TaskStatus }[] = [
  { label: "Pending", value: "pending" },
  { label: "In Progress", value: "in-progress" },
  { label: "Done", value: "done" },
  { label: "Review", value: "review" },
  { label: "Deferred", value: "deferred" },
  { label: "Cancelled", value: "cancelled" },
];

const priorityOptions = [
  { label: "High", value: "high" },
  { label: "Medium", value: "medium" },
  { label: "Low", value: "low" },
  { label: "(None)", value: "none" }, // Add an option for no priority
];

type FormFields = "title" | "description" | "status" | "priority" | "product";

export function CreateTaskScreen() {
  const navigate = useNavigate();
  const { addTask, products } = useAppStore((state) => ({
    addTask: state.addTask,
    products: state.products,
  }));

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<TaskStatus>("pending");
  const [priority, setPriority] = useState<string>("medium"); // Default priority
  const [productId, setProductId] = useState<string>("none"); // Default to no product

  // Map products to Select options, adding a "None" option
  const productOptions = [
    { label: "(None)", value: "none" },
    ...products.map((p) => ({ label: p.name, value: p.id })),
  ];

  const [activeField, setActiveField] = useState<FormFields>("title");

  const handleSubmit = () => {
    if (!title) return; // Require title

    const newTask: Partial<Task> = {
      title,
      description: description || undefined,
      status,
      priority:
        priority !== "none" ? (priority as Task["priority"]) : undefined,
      productId: productId !== "none" ? productId : undefined,
    };

    addTask(newTask as Task);
    // Navigate back, maybe to the task list or product screen
    navigate(-1);
  };

  // Simple focus management: cycle through fields on Enter/Submit
  const fieldOrder: FormFields[] = [
    "title",
    "description",
    "status",
    "priority",
    "product",
  ];

  const focusNextField = () => {
    const currentIndex = fieldOrder.indexOf(activeField);
    const nextIndex = (currentIndex + 1) % fieldOrder.length;
    const nextField = fieldOrder[nextIndex];
    if (nextField) {
      setActiveField(nextField);
    }
  };

  useInput((input, key) => {
    if (key.escape) {
      navigate(-1); // Go back
    }
    // We rely on the onSubmit of TextInput and onChange of Select for field changes/submission
  });

  return (
    <Box flexDirection="column" padding={1}>
      <PageHeader
        title="Create New Task"
        showBackButton
        onBack={() => navigate(-1)}
      />

      <Box flexDirection="column" gap={1} marginTop={1}>
        {/* Title */}
        <Box>
          <Box width={15}>
            <Text bold>Title:</Text>
          </Box>
          <TextInput
            placeholder="Enter task title..."
            isDisabled={activeField !== "title"}
            onChange={setTitle} // Update state directly
            onSubmit={() => focusNextField()}
          />
        </Box>
        {/* Description */}
        <Box>
          <Box width={15}>
            <Text bold>Description:</Text>
          </Box>
          <TextInput
            placeholder="Enter description (optional)..."
            isDisabled={activeField !== "description"}
            onChange={setDescription}
            onSubmit={() => focusNextField()}
          />
        </Box>
        {/* Status */}
        <Box>
          <Box width={15}>
            <Text bold>Status:</Text>
          </Box>
          <Select
            options={statusOptions}
            isDisabled={activeField !== "status"}
            onChange={(value) => {
              setStatus(value as TaskStatus);
              focusNextField();
            }}
          />
        </Box>
        {/* Priority */} // Make sure Select value is string
        <Box>
          <Box width={15}>
            <Text bold>Priority:</Text>
          </Box>
          <Select
            options={priorityOptions}
            isDisabled={activeField !== "priority"}
            onChange={(value) => {
              setPriority(value);
              focusNextField();
            }}
          />
        </Box>
        {/* Product */}
        <Box>
          <Box width={15}>
            <Text bold>Product:</Text>
          </Box>
          <Select
            options={productOptions}
            isDisabled={activeField !== "product"}
            onChange={(value) => {
              setProductId(value);
              // Submit after the last field
              handleSubmit();
            }}
          />
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Use Enter to move to the next field or submit.</Text>
      </Box>
    </Box>
  );
}
