import { openai } from "@ai-sdk/openai";
import { generateText, tool } from "ai";
import { z } from "zod";

export async function generateImage(prompt: string) {
  const result = await generateText({
    model: openai("gpt-4-turbo"),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "can you log this meal for me?" },
          {
            type: "image",
            image: new URL(
              "https://upload.wikimedia.org/wikipedia/commons/thumb/e/e4/Cheeseburger_%2817237580619%29.jpg/640px-Cheeseburger_%2817237580619%29.jpg",
            ),
          },
        ],
      },
    ],
    tools: {
      logFood: tool({
        description: "Log a food item",
        parameters: z.object({
          name: z.string(),
          calories: z.number(),
        }),
        execute: async ({ name, calories }) => {
          console.log("logFood", name, calories);
          // await storeInDatabase({ name, calories });

          return {
            success: true,
            message: "Food item logged successfully",
          };
        },
      }),
    },
  });

  return result;
}
