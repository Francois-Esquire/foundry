import type { LanguageModel } from "ai";

import { generateText } from "ai";
import { v4 as uuidv4 } from "uuid";

import { DocumentType } from "./generator";

// User Journey generation options
export interface UserJourneyOptions {
  title?: string;
  maxTokens?: number;
  temperature?: number;
  includeEmotionalJourney?: boolean;
  includePainPoints?: boolean;
  includeOpportunities?: boolean;
}

// User Journey document structure
export interface UserJourneyDocument {
  id: string;
  type: string;
  title: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, any>;
}

/**
 * Generates a User Journey document based on a persona and scenario
 *
 * @param agent The generator agent that will create the content
 * @param persona The user persona to generate the journey for
 * @param scenario The scenario the persona is going through
 * @param options Optional generation parameters
 * @returns The generated User Journey document (not yet saved)
 */
export async function generateUserJourney(
  agent: LanguageModel,
  persona: string,
  scenario: string,
  options?: UserJourneyOptions,
): Promise<UserJourneyDocument> {
  // Prepare the prompt for user journey generation
  const prompt = prepareUserJourneyPrompt(persona, scenario, options);

  // Generate the user journey content
  const content = await generateText({
    model: agent,
    prompt,
    maxTokens: options?.maxTokens || 3000,
    temperature: options?.temperature || 0.7,
  });

  // Create document object
  return {
    id: uuidv4(),
    type: DocumentType.USER_JOURNEY,
    title: options?.title || `User Journey: ${persona} - ${scenario}`,
    content: content.text,
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata: {
      persona,
      scenario,
      generationOptions: options,
    },
  };
}

/**
 * Prepares the prompt for user journey generation
 */
function prepareUserJourneyPrompt(
  persona: string,
  scenario: string,
  options?: UserJourneyOptions,
): string {
  let prompt = `Generate a detailed user journey for the following persona: "${persona}" in the scenario: "${scenario}".\n\n`;

  prompt += "Include the following elements:\n";
  prompt += "1. Persona Profile: Detailed description of the user\n";
  prompt += "2. User Goals: What the user wants to accomplish\n";
  prompt += "3. Journey Map: Step-by-step sequence of interactions\n";
  prompt += "4. Touchpoints: Where the user interacts with the product\n";

  if (options?.includeEmotionalJourney !== false) {
    prompt += "5. Emotions: User's emotional state at each step\n";
  }

  if (options?.includePainPoints !== false) {
    prompt +=
      "6. Pain Points: Challenges or frustrations the user experiences\n";
  }

  if (options?.includeOpportunities !== false) {
    prompt +=
      "7. Opportunities: Areas for improvement to enhance the experience\n";
  }

  prompt +=
    "\nFormat the document using Markdown syntax. Focus on creating a realistic and empathetic user journey.";

  return prompt;
}
