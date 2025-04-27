import React from "react";
import { Box, Text, useInput } from "ink";

interface CreateButtonProps {
  label: string;
  onClick: () => void;
  isFocused: boolean;
}

export function CreateButton({ label, onClick, isFocused }: CreateButtonProps) {
  // Handle keyboard input
  useInput((input, key) => {
    if (isFocused && key.return) {
      onClick();
    }
  });

  return (
    <Box marginY={1}>
      <Text color={isFocused ? "green" : undefined}>
        {isFocused ? "› " : "  "}
        {label}
      </Text>
    </Box>
  );
}
