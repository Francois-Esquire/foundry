import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";

export async function webSearch(
  query: string,
  options?: Parameters<typeof generateText>[0],
) {
  const result = await generateText({
    ...options,
    model: openai.responses("gpt-4o-mini"),
    prompt: query,
    tools: {
      ...options?.tools,
      web_search_preview: openai.tools.webSearchPreview(),
    },
  });

  return {
    ...result,
  };
}
