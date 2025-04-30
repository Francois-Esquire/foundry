import { useState } from "react";
import { Box, Text, useFocus } from "ink";

type SlashCommand = {
  command: string;
  description: string;
};

const SLASH_COMMANDS: SlashCommand[] = [
  {
    command: "help",
    description: "Show help",
  },
  {
    command: "exit",
    description: "Exit the CLI",
  },
];

export function TerminalChatCommands({
  input = "",
  selectedSlashSuggestion = 0,
}: {
  input?: string;
  selectedSlashSuggestion: number;
}) {
  // const [selectedSlashSuggestion, setSelectedSlashSuggestion] = useState(0);
  const { isFocused } = useFocus({
    id: "chat-commands",
  });

  return (
    <Box
      flexDirection="column"
      borderColor="blueBright"
      borderStyle="round"
      paddingX={2}
      marginBottom={1}
    >
      <Text> </Text>
      {SLASH_COMMANDS.filter((cmd: SlashCommand) =>
        cmd.command.includes(input.trim().replace(/^\//, "")),
      ).map((cmd: SlashCommand, idx: number) => (
        <Box key={cmd.command}>
          <Text>* </Text>
          <Text
            backgroundColor={
              idx === selectedSlashSuggestion - 1 ? "blackBright" : undefined
            }
          >
            <Text color="blueBright">{cmd.command}</Text>
            <Text> {cmd.description}</Text>
          </Text>
        </Box>
      ))}
    </Box>
  );
}
