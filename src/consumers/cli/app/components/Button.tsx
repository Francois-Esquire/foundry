import React from "react";
import { Box, Text, useFocus, useInput } from "ink";

import { theme } from "../theme"; // Import theme

interface ButtonProps {
  variant?: "primary" | "outline" | "ghost";
  onPress: () => void;
  children: React.ReactNode;
  autoFocus?: boolean;
}

export function Button({
  onPress,
  children,
  autoFocus = false,
  variant = "primary",
}: ButtonProps) {
  // Use the built-in useFocus hook from Ink
  const { isFocused } = useFocus({ autoFocus });

  // Handle Enter key press when focused
  useInput((input, key) => {
    if (isFocused && key.return) {
      onPress();
    }
  });

  // For ghost variant that's not focused, render just the text without a box
  if (variant === "ghost") {
    return (
      <Text color={isFocused ? theme.colors.primary : theme.colors.textDim}>
        {children}
      </Text>
    );
  }

  // Determine styling based on variant and focus state
  let borderStyle = theme.borders.default;
  let borderColor = theme.colors.border;
  let textColor = theme.colors.text;
  let paddingX = theme.spacing.sm;
  let paddingY = 1;

  // Apply variant-specific styling
  switch (variant) {
    case "primary":
      textColor = theme.colors.primary;
      break;
    case "outline":
      textColor = theme.colors.text;
      break;
    // case "ghost":
    //   // Ghost button when focused
    //   textColor = theme.colors.primary;
    //   break;
  }

  // Add focus styling for all variants
  if (isFocused) {
    // When focused, all buttons show a border in primary color
    borderStyle = theme.borders.default;
    borderColor = theme.colors.primary;
    textColor = theme.colors.primary;
  }

  return (
    <Box
      borderStyle={borderStyle}
      borderColor={borderColor}
      paddingX={paddingX}
      paddingY={paddingY}
      alignSelf="center"
    >
      <Text color={textColor}>{children}</Text>
    </Box>
  );
}
