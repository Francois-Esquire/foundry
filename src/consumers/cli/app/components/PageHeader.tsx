import React from "react";
import { Box, Text, useInput } from "ink";

interface PageHeaderProps {
  title: string;
  showBackButton?: boolean;
  onBack?: () => void;
}

export function PageHeader({
  title,
  showBackButton = false,
  onBack,
}: PageHeaderProps) {
  // Handle back button navigation
  useInput((input, key) => {
    if (showBackButton && onBack && (key.escape || key.ctrl)) {
      onBack();
    }
  });

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold color="blue">
          {title}
        </Text>
      </Box>

      {showBackButton && (
        <Box marginTop={1}>
          <Text dimColor>Press Esc to go back</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text>{"─".repeat(title.length > 20 ? 40 : 20)}</Text>
      </Box>
    </Box>
  );
}
