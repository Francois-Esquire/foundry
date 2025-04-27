import fs from "fs/promises"; // Use promises API
import path from "path";

import { useCallback, useEffect, useState } from "react";

// Basic interface for environment variables (key-value)
export interface EnvVar {
  key: string;
  value: string;
}

// Hook return type
interface UseEnvManagerReturn {
  envVars: EnvVar[];
  loading: boolean;
  error: string | null;
  // eslint-disable-next-line no-unused-vars
  addEnvVar: (key: string, value: string) => Promise<void>;
  // eslint-disable-next-line no-unused-vars
  removeEnvVar: (keyToRemove: string) => Promise<void>;
  refreshEnvVars: () => Promise<EnvVar[]>;
}

const ENV_FILENAME = ".env";

/**
 * Hook to manage environment variables in a .env file.
 * @param projectBasePath The absolute path to the project root directory.
 */
export function useEnvManager(
  projectBasePath: string | null,
): UseEnvManagerReturn {
  const [envVars, setEnvVars] = useState<EnvVar[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const envFilePath = projectBasePath
    ? path.join(projectBasePath, ENV_FILENAME)
    : null;

  // Function to load/parse .env file
  const loadEnvFile = useCallback(async (): Promise<EnvVar[]> => {
    if (!envFilePath) {
      setError("Project base path not set.");
      setLoading(false);
      return [];
    }
    setLoading(true);
    setError(null);
    try {
      const fileContent = await fs.readFile(envFilePath, "utf-8");
      const lines = fileContent.split("\n");
      const loadedVars = lines
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#")) // Ignore empty lines and comments
        .map((line) => {
          const separatorIndex = line.indexOf("=");
          if (separatorIndex === -1) return null; // Invalid line format
          const key = line.substring(0, separatorIndex).trim();
          const value = line.substring(separatorIndex + 1).trim();
          // Optional: Handle quoted values if necessary
          return { key, value };
        })
        .filter((v): v is EnvVar => v !== null); // Type guard to filter out nulls
      setEnvVars(loadedVars);
      return loadedVars;
    } catch (err: any) {
      if (err.code === "ENOENT") {
        // .env file doesn't exist, which is fine
        setEnvVars([]);
        return [];
      } else {
        console.error(`Error reading .env file at ${envFilePath}:`, err);
        setError(`Failed to load .env file: ${err.message}`);
        setEnvVars([]);
        return [];
      }
    } finally {
      setLoading(false);
    }
  }, [envFilePath]);

  // Function to save env vars back to .env file
  const saveEnvFile = useCallback(
    async (varsToSave: EnvVar[]) => {
      if (!envFilePath) {
        setError("Project base path not set. Cannot save.");
        return;
      }
      setLoading(true);
      setError(null);
      try {
        // TODO: Preserve comments and empty lines if necessary (more complex parsing/writing)
        const fileContent = varsToSave
          .map((v) => `${v.key}=${v.value}`)
          .join("\n");
        await fs.writeFile(envFilePath, fileContent, "utf-8");
        setEnvVars(varsToSave); // Update state after successful save
      } catch (err: any) {
        console.error(`Error writing .env file at ${envFilePath}:`, err);
        setError(`Failed to save .env file: ${err.message}`);
        // Optionally reload to revert state? Or keep optimistic update?
      } finally {
        setLoading(false);
      }
    },
    [envFilePath],
  );

  // Function to add/update an env var
  const addEnvVar = useCallback(
    async (key: string, value: string) => {
      if (!key) return; // Basic validation
      const currentVars = await loadEnvFile(); // Ensure we have the latest
      const existingIndex = currentVars.findIndex((v) => v.key === key);
      let updatedVars;
      if (existingIndex !== -1) {
        // Update existing
        updatedVars = currentVars.map((v, index) =>
          index === existingIndex ? { key, value } : v,
        );
      } else {
        // Add new
        updatedVars = [...currentVars, { key, value }];
      }
      await saveEnvFile(updatedVars);
    },
    [loadEnvFile, saveEnvFile],
  );

  // Function to remove an env var
  const removeEnvVar = useCallback(
    async (keyToRemove: string) => {
      const currentVars = await loadEnvFile(); // Ensure we have the latest
      const updatedVars = currentVars.filter((v) => v.key !== keyToRemove);
      if (updatedVars.length !== currentVars.length) {
        // Only save if something changed
        await saveEnvFile(updatedVars);
      }
    },
    [loadEnvFile, saveEnvFile],
  );

  // Load initial data on mount or when basePath changes
  useEffect(() => {
    if (projectBasePath) {
      loadEnvFile();
    }
  }, [projectBasePath, loadEnvFile]);

  return {
    envVars,
    loading,
    error,
    addEnvVar,
    removeEnvVar,
    refreshEnvVars: loadEnvFile,
  };
}
