import { Box, Text } from "ink";

import { useStreamingChat } from "../../hooks/useStreamingChat";
import { TerminalChat } from "./chat";
import { Messages } from "./messages";

export default function CLI() {
  // Use our streaming chat hook with debug mode disabled by default
  const { messages, streamingMessage, isLoading, sendMessage } =
    useStreamingChat({
      debug: false,
      initialMessages: [
        {
          id: "welcome",
          content: "Welcome to Foundry Chat! How can I help you today?",
          isUser: false,
          timestamp: Date.now(),
        },
      ],
      onMessageComplete: () => {
        // Auto-scroll to bottom when message is complete
        // scrollToBottom();
      },
    });
  return (
    <Box flexDirection="column">
      <Messages messages={messages} stream={streamingMessage} />
      <TerminalChat onSendMessage={sendMessage} isLoading={isLoading} />
      <Box
        flexDirection="column"
        justifyContent="flex-start"
        alignItems="flex-start"
        borderTop={true}
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
      >
        <Text dimColor>
          ctrl+c to exit | "/" to see commands | enter to send
        </Text>
      </Box>
    </Box>
  );
}
