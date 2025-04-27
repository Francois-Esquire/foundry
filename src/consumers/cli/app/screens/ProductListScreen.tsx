import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useNavigate } from "react-router";

import { CreateButton } from "../components/CreateButton";
import { PageHeader } from "../components/PageHeader";
import { ProductSelector } from "../components/ProductSelector";
import { useAppStore } from "../store";

export function ProductListScreen() {
  const navigate = useNavigate();
  const { products } = useAppStore();

  // Use a state to determine if create button is focused or the product list
  const [focusCreate, setFocusCreate] = useState(products.length === 0);

  // Handle keyboard navigation between buttons
  useInput((input, key) => {
    if (products.length > 0) {
      if (key.upArrow && !focusCreate) {
        setFocusCreate(true);
      } else if (key.downArrow && focusCreate) {
        setFocusCreate(false);
      }
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <PageHeader title="Product Manager" />

      <CreateButton
        label="➕ Create new product"
        onClick={() => {
          navigate("/products/create");
        }}
        isFocused={focusCreate}
      />

      {!focusCreate && products.length > 0 ? (
        <ProductSelector
          products={products}
          onSelect={(id: string) => {
            navigate(`/products/${id}`);
          }}
        />
      ) : (
        products.length === 0 && (
          <Box marginY={1}>
            <Text dimColor>No products found. Create your first one!</Text>
          </Box>
        )
      )}

      <Box marginTop={1}>
        <Text dimColor>
          {products.length > 0
            ? "Use ↑ and ↓ to navigate, Enter to select"
            : "Press Enter to create a new product"}
        </Text>
      </Box>
    </Box>
  );
}
