import { UnorderedList } from "@inkjs/ui";
import { Box, Text } from "ink";

import type { ChatMessage } from "../../hooks/useStreamingChat";

import "node_modules/@inkjs/ui/build/components/ordered-list/ordered-list-item";

export function Messages({
  messages,
  stream,
}: {
  messages: ChatMessage[];
  stream?: string;
}) {
  return (
    <Box>
      <UnorderedList>
        {messages.map((message) => (
          <UnorderedList.Item key={message.id}>
            <Text>{message.content}</Text>
          </UnorderedList.Item>
        ))}
        {stream && (
          <UnorderedList.Item key={stream}>
            <Text>{stream}</Text>
          </UnorderedList.Item>
        )}
      </UnorderedList>
    </Box>
  );
}
