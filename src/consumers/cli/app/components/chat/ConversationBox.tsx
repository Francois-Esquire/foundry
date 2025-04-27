import React from "react";
import { Box } from "ink";

import type { ChatMessage } from "../../hooks/useStreamingChat";

import { theme } from "../../theme";
import { Message } from "./Message";

interface ConversationBoxProps {
  messages: ChatMessage[];
  streamingMessage: string;
  isLoading: boolean;
  scrollPosition: number;
  visibleHeight: number;
}

export function ConversationBox({
  messages,
  streamingMessage,
  isLoading,
  scrollPosition,
  visibleHeight,
}: ConversationBoxProps) {
  // Adjust container height for borders
  const containerHeight = Math.max(visibleHeight, 10); // Minimum visible height to avoid squishing

  // Message height assumptions - used for calculating scroll positions
  const messageHeight = 3; // Estimate: 1 line of text + padding + borders
  const totalMessagesHeight = messages.length * messageHeight;

  // Calculate which messages are visible based on scroll position
  const allMessages = [...messages];

  // Add the streaming message or "Thinking..." if needed
  if (isLoading || streamingMessage) {
    allMessages.push({
      id: `ai-stream-${Date.now()}`,
      content: streamingMessage || "Thinking...",
      isUser: false,
      timestamp: Date.now(),
    });
  }

  // Calculate visible range based on scroll position and container height
  const startIdx = Math.max(
    0,
    allMessages.length -
      Math.floor(containerHeight / messageHeight) -
      scrollPosition,
  );
  const endIdx = allMessages.length;

  // Get only the visible messages
  const visibleMessages = allMessages.slice(startIdx, endIdx);

  return (
    <Box
      borderStyle="round"
      borderColor={theme.colors.border}
      height={containerHeight}
      flexDirection="column"
      overflow="hidden"
    >
      <Box
        flexDirection="column"
        height={containerHeight - 2} // Account for borders
        overflow="hidden"
        paddingX={1}
      >
        {/* Render visible messages with fixed heights */}
        {visibleMessages.map((message, index) => (
          <Message
            key={`${message.id}-${index}`}
            role={message.isUser ? "user" : "assistant"}
            content={message.content}
            marginY={0.5}
            paddingY={0.5}
          />
        ))}

        {/* Add empty space at bottom if needed for proper sizing */}
        {visibleMessages.length <
          Math.floor((containerHeight - 2) / messageHeight) && (
          <Box
            height={
              containerHeight - 2 - visibleMessages.length * messageHeight
            }
          />
        )}
      </Box>
    </Box>
  );
}
