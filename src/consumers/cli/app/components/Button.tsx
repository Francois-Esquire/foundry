import React from "react";
import { Box, Text, useInput } from "ink";

import { theme } from "../theme"; // Import theme

interface ButtonProps {
  onPress: () => void;
  children: React.ReactNode;
  isFocused?: boolean; // Allow parent to control focus appearance
}

export function Button({ onPress, children, isFocused = false }: ButtonProps) {
  // Handle Enter key press when the button is intended to be focused
  // Note: Actual focus management might need to be handled by the parent component
  // if there are multiple focusable elements.
  useInput((input, key) => {
    if (isFocused && key.return) {
      onPress();
    }
  });

  const currentBorderColor = isFocused
    ? theme.colors.borderFocused
    : theme.colors.border;
  const currentTextColor = isFocused ? theme.colors.primary : theme.colors.text;

  return (
    // Add some styling for definition
    <Box
      borderStyle={theme.borders.default}
      borderColor={currentBorderColor}
      paddingX={theme.spacing.sm} // Use theme spacing
      alignSelf="center" // Center the button itself
    >
      <Text color={currentTextColor}>{children}</Text>
    </Box>
  );
}
