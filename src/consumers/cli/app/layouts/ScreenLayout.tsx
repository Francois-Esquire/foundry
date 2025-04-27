import React, { useEffect, useState } from "react";
import { Box, useStdout } from "ink";

export function ScreenLayout({ children }: { children: React.ReactNode }) {
  const { stdout } = useStdout();
  const [dimensions, setDimensions] = useState<[number, number]>([
    stdout.columns,
    stdout.rows,
  ]);

  useEffect(() => {
    const handler = () => setDimensions([stdout.columns, stdout.rows]);
    stdout.on("resize", handler);
    return () => {
      stdout.off("resize", handler);
    };
  }, [stdout]);

  return (
    <Box
      flexDirection="column"
      justifyContent="space-between"
      alignItems="stretch"
      width={dimensions[0]}
      height={dimensions[1]}
    >
      {children}
    </Box>
  );
}
