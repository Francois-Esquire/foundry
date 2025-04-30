import React, { useState } from "react";
// Use components from @inkjs/ui
import { Select, Spinner, TextInput } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import { useNavigate } from "react-router";

import { Button } from "../components/Button";
import { Section } from "../components/Section";
import { useEnvManager } from "../hooks/useEnvManager"; // Import the hook
import { useAppStore } from "../store";
import { theme } from "../theme";

// Focusable elements
type ConfigFocus =
  | "basePath"
  | "autoImport"
  | "envKeyInput"
  | "envValueInput"
  | "addEnvButton"
  | "envList";

export function ConfigureScreen() {
  const navigate = useNavigate();
  const config = useAppStore((state) => state.config);
  const setBasePath = useAppStore((state) => state.setBasePath);
  const setAutoImportMCPs = useAppStore((state) => state.setAutoImportMCPs);

  // --- Env Var Management --- //
  const {
    envVars,
    loading: envLoading,
    error: envError,
    addEnvVar,
    removeEnvVar,
  } = useEnvManager(config.basePath);
  const [newEnvKey, setNewEnvKey] = useState("");
  const [newEnvValue, setNewEnvValue] = useState("");
  const [selectedEnvIndex, setSelectedEnvIndex] = useState(0); // For navigating the list

  // --- Focus Management --- //
  const [focusedElement, setFocusedElement] = useState<ConfigFocus>("basePath");
  const focusOrder: ConfigFocus[] = [
    "basePath",
    "autoImport",
    "envKeyInput",
    "envValueInput",
    "addEnvButton",
    ...(envVars.length > 0 ? ["envList" as ConfigFocus] : []), // Only focus list if not empty
  ];

  // --- Handlers --- //
  const handleBasePathSubmit = (value: string) => {
    setBasePath(value);
    // Focus next element
    focusNext();
  };

  const handleAutoImportChange = (value: string) => {
    setAutoImportMCPs(value === "true");
    focusNext();
  };

  const handleAddEnv = async () => {
    if (newEnvKey && newEnvValue) {
      await addEnvVar(newEnvKey, newEnvValue);
      setNewEnvKey("");
      setNewEnvValue("");
      // Optionally refresh or rely on state update from hook
      // focusNext(); // Decide where focus should go after adding
      setFocusedElement("envKeyInput"); // Go back to key input
    }
  };

  const handleRemoveEnv = async (keyToRemove: string | undefined) => {
    if (keyToRemove) {
      await removeEnvVar(keyToRemove);
      setSelectedEnvIndex((prev) =>
        Math.max(0, Math.min(prev, envVars.length - 2)),
      );
    }
  };

  // --- Input Hook --- //
  const focusNext = () => {
    const currentIndex = focusOrder.indexOf(focusedElement);
    const nextIndex = (currentIndex + 1) % focusOrder.length;
    const nextElement = focusOrder[nextIndex];
    if (nextElement) setFocusedElement(nextElement);
  };
  const focusPrev = () => {
    const currentIndex = focusOrder.indexOf(focusedElement);
    const prevIndex =
      (currentIndex - 1 + focusOrder.length) % focusOrder.length;
    const prevElement = focusOrder[prevIndex];
    if (prevElement) setFocusedElement(prevElement);
  };

  useInput((input, key) => {
    if (key.escape) {
      navigate(-1);
      return;
    }

    // Basic Tab/Shift+Tab navigation (can be improved)
    if (key.tab && !key.shift) {
      focusNext();
      return;
    }
    if (key.tab && key.shift) {
      focusPrev();
      return;
    }

    // List navigation
    if (focusedElement === "envList" && envVars.length > 0) {
      if (key.upArrow) {
        setSelectedEnvIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setSelectedEnvIndex((prev) => Math.min(envVars.length - 1, prev + 1));
      } else if (key.delete || key.backspace) {
        handleRemoveEnv(envVars[selectedEnvIndex]?.key);
      }
    }

    // Enter key press on Add button
    if (focusedElement === "addEnvButton" && key.return) {
      handleAddEnv();
    }
  });

  // --- UI Components --- //
  const autoImportItems = [
    { label: "Yes", value: "true" },
    { label: "No", value: "false" },
  ];

  return (
    <Box
      flexDirection="column"
      padding={theme.spacing.sm}
      gap={theme.spacing.md}
    >
      <Section title="General Configuration" gap={1}>
        {/* Base Path */}
        <Box>
          <Box width={20}>
            <Text bold>Base Path:</Text>
          </Box>
          <TextInput
            defaultValue={config.basePath}
            onSubmit={handleBasePathSubmit}
            placeholder="Enter project base path..."
            isDisabled={focusedElement !== "basePath"}
          />
        </Box>
        {/* Auto Import */}
        <Box>
          <Box width={20}>
            <Text bold>Auto Import MCPs:</Text>
          </Box>
          <Select
            options={autoImportItems}
            onChange={handleAutoImportChange}
            isDisabled={focusedElement !== "autoImport"}
          />
        </Box>
      </Section>

      <Section title="Environment Variables (.env)" gap={1}>
        {envLoading && <Spinner />}
        {envError && <Text color="red">Error: {envError}</Text>}
        {!envLoading && (
          <Box flexDirection="column" gap={1}>
            {/* List Existing Vars */}
            <Box
              flexDirection="column"
              borderStyle="round"
              paddingX={1}
              minHeight={3}
            >
              {envVars.length === 0 && (
                <Text dimColor>No variables found in .env</Text>
              )}
              {envVars.map((env, index) => {
                const isFocused =
                  focusedElement === "envList" && selectedEnvIndex === index;
                return (
                  <Box
                    key={env.key}
                    gap={1}
                    borderStyle={isFocused ? "single" : undefined}
                    borderColor={
                      isFocused ? theme.colors.borderFocused : undefined
                    }
                    paddingX={isFocused ? 0 : 1}
                  >
                    <Text
                      bold
                      color={
                        isFocused
                          ? theme.colors.borderFocused
                          : theme.colors.primary
                      }
                    >
                      {env.key}:
                    </Text>
                    <Text
                      color={isFocused ? theme.colors.borderFocused : undefined}
                    >
                      ********
                    </Text>
                    {isFocused && (
                      <Text dimColor> (Press Delete to remove)</Text>
                    )}
                  </Box>
                );
              })}
            </Box>
            {envVars.length > 0 && focusedElement !== "envList" && (
              <Text dimColor>(Tab/Arrows to navigate list)</Text>
            )}

            {/* Add New Var Form */}
            <Box gap={1} marginTop={1}>
              <TextInput
                placeholder="KEY"
                defaultValue={newEnvKey}
                onChange={setNewEnvKey}
                isDisabled={focusedElement !== "envKeyInput"}
                onSubmit={() => setFocusedElement("envValueInput")}
              />
              <TextInput
                placeholder="VALUE (sensitive)"
                defaultValue={newEnvValue}
                onChange={setNewEnvValue}
                isDisabled={focusedElement !== "envValueInput"}
                onSubmit={handleAddEnv}
              />
              <Button onPress={handleAddEnv}>Add/Update</Button>
            </Box>
          </Box>
        )}
      </Section>
      <Box justifyContent="center">
        <Text dimColor>
          (Use Tab/Shift+Tab or Arrows to navigate, Enter to select/submit, Esc
          to go back)
        </Text>
      </Box>
    </Box>
  );
}
