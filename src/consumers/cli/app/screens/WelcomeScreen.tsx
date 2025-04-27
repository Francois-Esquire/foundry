import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useNavigate } from "react-router";

import { PageFooter } from "../components/PageFooter";
import { WelcomeBanner } from "../components/welcome-banner";

export function WelcomeScreen() {
  const navigate = useNavigate();
  const [showPrompt, setShowPrompt] = useState(false);

  // Show the enter prompt after a short delay for better UX
  useEffect(() => {
    const timer = setTimeout(() => {
      setShowPrompt(true);
    }, 0);

    return () => clearTimeout(timer);
  }, []);

  // Use the useInput hook to capture Enter key press
  useInput((input, key) => {
    if (showPrompt && key.return) {
      navigate("/dashboard");
    } else if (key.escape) {
      process.exit(0);
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <WelcomeBanner />
      <Box marginY={1}>
        <Text bold>Welcome to Foundry CLI</Text>
      </Box>

      <Box marginY={1}>
        <Text>
          Easily manage your products, user journeys, and system documentation.
        </Text>
      </Box>

      {showPrompt && (
        <Box marginY={1}>
          <Text color="green">Press Enter to continue →</Text>
        </Box>
      )}

      <PageFooter helpText="(Press Enter to continue, Esc to exit)" />
    </Box>
  );
}
