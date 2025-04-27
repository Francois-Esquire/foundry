// import { generateText, tool } from 'ai';
// import { openai } from '@ai-sdk/openai';
// import { z } from 'zod';
// import Exa from 'exa-js';

// export const exa = new Exa(process.env.EXA_API_KEY);

// export const webSearch = tool({
//   description: 'Search the web for up-to-date information',
//   parameters: z.object({
//     query: z.string().min(1).max(100).describe('The search query'),
//   }),
//   execute: async ({ query }) => {
//     const { results } = await exa.searchAndContents(query, {
//       livecrawl: 'always',
//       numResults: 3,
//     });
//     return results.map(result => ({
//       title: result.title,
//       url: result.url,
//       content: result.text.slice(0, 1000), // take just the first 1000 characters
//       publishedDate: result.publishedDate,
//     }));
//   },
// });

// const { text } = await generateText({
//   model: openai('gpt-4o-mini'), // can be any model that supports tools
//   prompt: 'What happened in San Francisco last week?',
//   tools: {
//     webSearch,
//   },
//   maxSteps: 2,
// });

import { openai } from "@ai-sdk/openai";
import { generateText, tool } from "ai";
import { z } from "zod";

const result = await generateText({
  model: openai("gpt-4-turbo"),
  tools: {
    weather: tool({
      description: "Get the weather in a location",
      parameters: z.object({
        location: z.string().describe("The location to get the weather for"),
      }),
      execute: async ({ location }: { location: string }) => ({
        location,
        temperature: 72 + Math.floor(Math.random() * 21) - 10,
      }),
    }),
    cityAttractions: tool({
      parameters: z.object({ city: z.string() }),
      execute: async ({ city }: { city: string }) => {
        if (city === "San Francisco") {
          return {
            attractions: [
              "Golden Gate Bridge",
              "Alcatraz Island",
              "Fisherman's Wharf",
            ],
          };
        } else {
          return { attractions: [] };
        }
      },
    }),
  },
  prompt:
    "What is the weather in San Francisco and what attractions should I visit?",
});

console.log(result);
