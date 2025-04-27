import React, { useState } from "react";
import { TextInput } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import { useNavigate } from "react-router";

import type { Product } from "../store";

import { useAppStore } from "../store";

type FormFields = "name" | "description";

export function CreateProductScreen() {
  const navigate = useNavigate();
  const { addProduct } = useAppStore();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [activeField, setActiveField] = useState<FormFields>("name");

  const handleSubmit = () => {
    if (!name) return;

    const newProduct: Partial<Product> = {
      name,
      description: description || undefined,
      createdAt: new Date(),
    };

    addProduct(newProduct as Product);
    navigate("/products");
  };

  const fieldOrder: FormFields[] = ["name", "description"];

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
      navigate("/products");
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold>Create New Product</Text>
      </Box>

      <Box marginY={1}>
        <Box width={15}>
          <Text bold>Name:</Text>
        </Box>
        <TextInput
          placeholder="Enter product name..."
          isDisabled={activeField !== "name"}
          onChange={setName}
          onSubmit={() => focusNextField()}
        />
      </Box>

      <Box marginY={1}>
        <Box width={15}>
          <Text bold>Description:</Text>
        </Box>
        <TextInput
          placeholder="Enter description (optional)..."
          isDisabled={activeField !== "description"}
          onChange={setDescription}
          onSubmit={handleSubmit}
        />
      </Box>

      <Box marginY={1}>
        <Text dimColor>
          Press Enter to move to the next field or submit. Press Esc to cancel.
        </Text>
      </Box>
    </Box>
  );
}
