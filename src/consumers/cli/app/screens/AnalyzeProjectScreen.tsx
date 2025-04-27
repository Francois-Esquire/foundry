import React, { useCallback, useEffect, useState } from "react";
import { Spinner } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import { useNavigate } from "react-router";

import { Button } from "../components/Button";
import { Section } from "../components/Section";
import { useAppStore } from "../store";
import { theme } from "../theme";

// Define the stages of the analysis process
type AnalysisStage =
  | "initial"
  | "askingPurpose"
  | "scanning"
  | "callingLLM"
  | "displayingResult"
  | "error";

// Define focusable elements for the error/result state
type EndStateFocus = "okButton" | "retryButton";

export function AnalyzeProjectScreen() {
  const navigate = useNavigate();
  const { tasks } = useAppStore();

  const [stage, setStage] = useState<AnalysisStage>("initial");
  const [analysisResult, setAnalysisResult] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [analysisLogs, setAnalysisLogs] = useState<string[]>([]);
  const [focusedEndButton, setFocusedEndButton] =
    useState<EndStateFocus>("okButton");

  // --- Helper to add logs --- //
  const addLog = useCallback((message: string) => {
    setAnalysisLogs((prevLogs) => [...prevLogs, message]);
  }, []);

  // --- Placeholder Functions --- //

  const askForPurpose = useCallback(async () => {
    addLog("Requesting project purpose...");
    setStage("askingPurpose");
    await new Promise((resolve) => setTimeout(resolve, 500));
    addLog("Project purpose received (simulated).");
    return "Simulated project purpose: Build a CLI tool.";
  }, [addLog]);

  const scanProjectFiles = useCallback(async () => {
    addLog("Scanning project files...");
    setStage("scanning");
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const packageJson = { name: "foundry-cli-placeholder", version: "0.1.0" };
    const readmeContent = "Placeholder README content.";
    addLog(" - package.json found.");
    addLog(" - README.md found.");
    addLog("Scanning complete.");
    return {
      packageJson,
      readmeContent,
    };
  }, [addLog]);

  const callLLM = useCallback(
    async (_scannedData: any, _purpose: string, _taskProgress: any) => {
      addLog("Calling LLM for analysis...");
      setStage("callingLLM");
      addLog("Sending request to LLM...");
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const result = `Placeholder LLM Analysis Result:\nThe project 'placeholder-name' appears to be a CLI tool. Based on the tasks, progress seems to be ongoing. The provided purpose aligns with the setup.`;
      addLog("LLM analysis received.");
      return result;
    },
    [addLog],
  );

  // --- Analysis Flow --- //
  // Extract analysis logic into a useCallback
  const runAnalysis = useCallback(async () => {
    setAnalysisLogs([]); // Clear logs on start/retry
    setErrorMessage(null); // Clear previous errors
    setAnalysisResult(null);
    setFocusedEndButton("okButton"); // Reset focus
    try {
      setStage("initial");
      addLog("Starting analysis...");
      const purpose = await askForPurpose();
      if (!purpose) {
        addLog("Analysis cancelled: No purpose provided.");
        setStage("initial");
        return;
      }
      const scannedData = await scanProjectFiles();
      const taskProgress = {
        totalTasks: tasks.length,
        pending: tasks.filter(
          (t) => t.status === "pending" || t.status === "in-progress",
        ).length,
        done: tasks.filter((t) => t.status === "done").length,
      };
      addLog("Summarized task progress.");
      const result = await callLLM(scannedData, purpose, taskProgress);
      setAnalysisResult(result);
      setStage("displayingResult");
    } catch (error: any) {
      console.error("Analysis Error:", error);
      const errorMsg =
        error.message || "An unknown error occurred during analysis.";
      addLog(`Error during analysis: ${errorMsg}`);
      setErrorMessage(errorMsg);
      setStage("error");
    }
  }, [addLog, askForPurpose, scanProjectFiles, callLLM, tasks]);

  // Run analysis on mount
  useEffect(() => {
    runAnalysis();
  }, [runAnalysis]); // Depend on the stable runAnalysis function

  // --- Input Handling (for back navigation) --- //
  useInput((input, key) => {
    if (key.escape) {
      navigate(-1);
      return; // Prevent further input handling
    }

    // Input handling specific to error/result stages
    if (stage === "displayingResult" || stage === "error") {
      const isErrorStage = stage === "error";
      const focusOrder: EndStateFocus[] = ["okButton"];
      if (isErrorStage) {
        focusOrder.push("retryButton"); // Add retry only in error state
      }

      const currentIndex = focusOrder.indexOf(focusedEndButton);

      if (currentIndex === -1) return; // Should not happen, but good practice

      let nextFocus: EndStateFocus | undefined;
      if (key.rightArrow || key.tab) {
        const nextIndex = (currentIndex + 1) % focusOrder.length;
        nextFocus = focusOrder[nextIndex];
      } else if (key.leftArrow) {
        const prevIndex =
          (currentIndex - 1 + focusOrder.length) % focusOrder.length;
        nextFocus = focusOrder[prevIndex];
      }

      if (nextFocus) {
        // Check if navigation happened and element exists
        setFocusedEndButton(nextFocus);
      } else if (key.return) {
        if (focusedEndButton === "okButton") {
          navigate(-1);
        } else if (focusedEndButton === "retryButton" && isErrorStage) {
          runAnalysis();
        }
      }
    }
  });

  // --- Render Logic based on Stage --- //
  const renderProgress = (statusText: string) => (
    <Box flexDirection="column" alignItems="center" width="100%">
      <Box alignItems="center" gap={1}>
        <Spinner />
        <Text>{statusText}</Text>
      </Box>
      {analysisLogs.length > 0 && (
        <Box
          marginTop={1}
          flexDirection="column"
          borderStyle="round"
          borderColor={theme.colors.border}
          paddingX={1}
          width="90%"
        >
          <Text dimColor>Progress:</Text>
          {analysisLogs.map((log, index) => (
            <Text key={index} dimColor>
              {" "}
              - {log}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );

  let content;
  switch (stage) {
    case "askingPurpose":
      content = renderProgress("Requesting project purpose...");
      break;
    case "scanning":
      content = renderProgress("Scanning project files...");
      break;
    case "callingLLM":
      content = renderProgress("Analyzing project with AI...");
      break;
    case "displayingResult":
      content = (
        <Box flexDirection="column" gap={1}>
          <Text bold color={theme.colors.success}>
            Analysis Complete:
          </Text>
          <Text wrap="wrap">{analysisResult}</Text>
          <Box marginTop={1}>
            <Button
              onPress={() => navigate(-1)}
              isFocused={focusedEndButton === "okButton"}
            >
              OK (Go Back)
            </Button>
          </Box>
        </Box>
      );
      break;
    case "error":
      content = (
        <Box flexDirection="column" gap={1}>
          <Text bold color={theme.colors.error}>
            Analysis Failed:
          </Text>
          <Text wrap="wrap">{errorMessage}</Text>
          {analysisLogs.length > 0 && (
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>Logs:</Text>
              {analysisLogs.map((log, index) => (
                <Text key={index} dimColor>
                  {" "}
                  - {log}
                </Text>
              ))}
            </Box>
          )}
          <Box marginTop={1}>
            <Button
              onPress={() => navigate(-1)}
              isFocused={focusedEndButton === "okButton"}
            >
              OK (Go Back)
            </Button>
          </Box>
        </Box>
      );
      break;
    case "initial":
    default:
      content = renderProgress("Preparing analysis...");
  }

  return (
    <Box
      flexDirection="column"
      padding={theme.spacing.sm}
      gap={theme.spacing.md}
    >
      {stage !== "displayingResult" && stage !== "error" && (
        <Box justifyContent="center">
          <Text dimColor>(Press Esc to cancel)</Text>
        </Box>
      )}

      <Section title="Project Analysis" width={80} center={true}>
        {content}
      </Section>
    </Box>
  );
}
