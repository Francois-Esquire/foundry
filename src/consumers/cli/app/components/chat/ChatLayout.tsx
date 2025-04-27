import React from "react";
import { Box, Text } from "ink";

import type { ChatMessage } from "../../hooks/useStreamingChat";

import { theme } from "../../theme";
import { PageHeader } from "../PageHeader";
import { ChatInput } from "./ChatInput";
import { ConversationBox } from "./ConversationBox";
import { ScrollButtons } from "./ScrollButtons";

interface ChatLayoutProps {
  messages: ChatMessage[];
  streamingMessage: string;
  isLoading: boolean;
  input: string;
  cursor: number;
  scrollPosition: number;
  maxScroll: number;
  visibleHeight: number;
  focusedElement: string;
  onBack: () => void;
  onSendMessage: (text: string) => void;
  scrollUp: () => void;
  scrollDown: () => void;
}

export function ChatLayout({
  messages,
  streamingMessage,
  isLoading,
  input,
  cursor,
  scrollPosition,
  maxScroll,
  visibleHeight,
  focusedElement,
  onBack,
  onSendMessage,
  scrollUp,
  scrollDown,
}: ChatLayoutProps) {
  return (
    <Box
      flexDirection="column"
      padding={theme.spacing.sm}
      gap={theme.spacing.md}
      height="100%"
    >
      {/* Page Header with Back Button */}
      <PageHeader
        title="Chat with Foundry Assistant"
        showBackButton
        onBack={onBack}
        isBackButtonFocused={focusedElement === "backButton"}
      />

      {/* Main content area with fixed layout */}
      <Box flexDirection="row" gap={1} flexGrow={1}>
        {/* Conversation area with fixed width */}
        <Box width="95%">
          <ConversationBox
            messages={messages}
            streamingMessage={streamingMessage}
            isLoading={isLoading}
            scrollPosition={scrollPosition}
            visibleHeight={visibleHeight}
          />
        </Box>

        {/* Scroll buttons with fixed width */}
        <Box width="5%">
          <ScrollButtons
            scrollUp={scrollUp}
            scrollDown={scrollDown}
            isUpButtonFocused={focusedElement === "scrollUp"}
            isDownButtonFocused={focusedElement === "scrollDown"}
            scrollPosition={scrollPosition}
            maxScroll={maxScroll}
          />
        </Box>
      </Box>

      {/* Input area with fixed position at bottom */}
      <Box marginTop={1}>
        <ChatInput
          input={input}
          cursor={cursor}
          isFocused={focusedElement === "input"}
          onSubmit={onSendMessage}
        />
      </Box>

      <Box justifyContent="center">
        <Text dimColor>
          (Tab to navigate, Enter to send/select, Esc to go back)
        </Text>
      </Box>
    </Box>
  );
}
