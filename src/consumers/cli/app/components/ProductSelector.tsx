import { useState } from "react";
import { Box, Text, useInput } from "ink";

import type { Product } from "../store";

interface ProductSelectorProps {
  products: Product[];
  onSelect: (_value: string) => void;
}

export function ProductSelector({ products, onSelect }: ProductSelectorProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Early return if no products
  if (products.length === 0) {
    return (
      <Box flexDirection="column" marginY={1}>
        <Text dimColor>No products found.</Text>
      </Box>
    );
  }

  // Create option items from products
  const options = products.map((product) => ({
    label: product.name,
    value: product.id,
    description:
      product.description && product.description.length > 30
        ? `${product.description.substring(0, 30)}...`
        : product.description,
  }));

  // Handle keyboard input for navigation
  useInput((input, key) => {
    if (key.upArrow) {
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev));
    } else if (key.downArrow) {
      setSelectedIndex((prev) => (prev < options.length - 1 ? prev + 1 : prev));
    } else if (key.return) {
      // Safety check
      if (
        options.length > 0 &&
        selectedIndex >= 0 &&
        selectedIndex < options.length
      ) {
        const selectedOption = options[selectedIndex];
        if (selectedOption) {
          onSelect(selectedOption.value);
        }
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Box marginY={1}>
        <Text dimColor>Select a product:</Text>
      </Box>

      <Box flexDirection="column">
        {options.map((option, index) => (
          <Box key={option.value} marginY={0.5}>
            <Text color={selectedIndex === index ? "green" : undefined}>
              {selectedIndex === index ? "› " : "  "}
              {option.label}
              {option.description && (
                <Text dimColor> — {option.description}</Text>
              )}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
