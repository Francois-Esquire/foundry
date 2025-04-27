import { useEffect, useState } from "react";
import { useStdout } from "ink";

interface TerminalDimensions {
  width: number;
  height: number;
  aspectRatio: number;
  isWide: boolean;
  isTall: boolean;
  isSmall: boolean;
}

/**
 * A hook that provides terminal dimensions and layout information
 *
 * @returns Information about terminal dimensions and helper properties
 */
export function useTerminalDimensions(): TerminalDimensions {
  const { stdout } = useStdout();
  const [dimensions, setDimensions] = useState<TerminalDimensions>({
    width: stdout.columns || 80,
    height: stdout.rows || 24,
    aspectRatio: (stdout.columns || 80) / (stdout.rows || 24),
    isWide: (stdout.columns || 80) / (stdout.rows || 24) > 2,
    isTall: (stdout.columns || 80) / (stdout.rows || 24) < 0.8,
    isSmall: (stdout.columns || 80) < 80 || (stdout.rows || 24) < 20,
  });

  useEffect(() => {
    // Initial calculation
    const calculateDimensions = () => {
      const width = stdout.columns || 80;
      const height = stdout.rows || 24;
      const aspectRatio = width / height;

      setDimensions({
        width,
        height,
        aspectRatio,
        isWide: aspectRatio > 2,
        isTall: aspectRatio < 0.8,
        isSmall: width < 80 || height < 20,
      });
    };

    // Calculate on mount
    calculateDimensions();

    // Set up listener for terminal resize
    const handleResize = () => calculateDimensions();
    stdout.on("resize", handleResize);

    // Clean up
    return () => {
      stdout.off("resize", handleResize);
    };
  }, [stdout]);

  return dimensions;
}
