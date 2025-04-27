import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";

import { theme } from "../../theme";

interface ChatLoaderProps {
  text?: string;
}

export function ChatLoader({ text = "Thinking" }: ChatLoaderProps) {
  const [dots, setDots] = useState("");

  // Animate the dots
  useEffect(() => {
    const interval = setInterval(() => {
      setDots((prev) => {
        if (prev.length >= 3) return "";
        return prev + ".";
      });
    }, 400);

    return () => clearInterval(interval);
  }, []);

  return (
    <Box flexDirection="row" marginY={theme.spacing.xs}>
      <Text color={theme.colors.secondary} bold>
        AI:
      </Text>
      <Box marginLeft={1}>
        <Text dimColor>
          {text}
          {dots}
          {/* Add spaces to prevent UI jumping when dots change */}
          <Text color="black">{".".repeat(3 - dots.length)}</Text>
        </Text>
      </Box>
    </Box>
  );
}
