import React from "react";
import { Box, Text } from "ink";

import { theme } from "../../theme";

interface MessageProps {
  role: "user" | "assistant" | "system";
  content: string;
  marginY?: number;
  paddingY?: number;
}

export function Message({
  role,
  content,
  marginY = 1,
  paddingY = 1,
}: MessageProps) {
  // Different styles based on message role
  const isUser = role === "user";

  // Style configuration
  const bgColor = isUser ? theme.colors.primary : theme.colors.secondary;
  const textColor = isUser ? theme.colors.text : theme.colors.text;
  const alignment = isUser ? "flex-end" : "flex-start";
  const borderColor = isUser ? theme.colors.border : theme.colors.border;

  // Process content to ensure proper handling of newlines and long text
  const lines = content.split("\n");

  return (
    <Box
      marginY={marginY}
      width="100%"
      justifyContent={alignment}
      flexDirection="column"
    >
      <Box
        paddingX={1}
        paddingY={paddingY}
        borderStyle="round"
        borderColor={borderColor}
        width={isUser ? "90%" : "85%"}
        flexShrink={1}
        flexGrow={0}
      >
        {lines.map((line, i) => (
          <Box key={i} width="100%">
            <Text color={textColor} wrap="wrap" backgroundColor={bgColor}>
              {line}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
