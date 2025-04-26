import { v4 as uuidv4 } from 'uuid';
import { DocumentType } from './generator';
import type { LanguageModel } from 'ai';
import { generateText } from 'ai';

// PRD generation options

// PRD generation options
export interface PRDOptions {
  title?: string;
  maxTokens?: number;
  temperature?: number;
  includeUserJourneys?: boolean;
  includeTechnicalConsiderations?: boolean;
  includeTimeline?: boolean;
}

// PRD document structure
export interface PRDDocument {
  id: string;
  type: string;
  title: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, any>;
}

/**
 * Generates a Product Requirements Document based on a concept
 *
 * @param agent The generator agent that will create the content
 * @param concept The product concept to generate the PRD for
 * @param options Optional generation parameters
 * @returns The generated PRD document (not yet saved)
 */
export async function generatePRD(
  agent: LanguageModel,
  concept: string,
  options?: PRDOptions
): Promise<PRDDocument> {
  // Prepare the prompt for PRD generation
  const prompt = preparePRDPrompt(concept, options);

  // Generate the PRD content
  const content = await generateText({
    model: agent,
    prompt,
    maxTokens: options?.maxTokens || 4000,
    temperature: options?.temperature || 0.7,
  });

  // Create document object
  return {
    id: uuidv4(),
    type: DocumentType.PRD,
    title: options?.title || `Product Requirements Document: ${concept}`,
    content: content.text,
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata: {
      concept,
      generationOptions: options,
    },
  };
}

/**
 * Prepares the prompt for PRD generation
 */
function preparePRDPrompt(concept: string, options?: PRDOptions): string {
  let prompt = `Generate a detailed Product Requirements Document for the following concept: "${concept}".\n\n`;

  prompt += 'Include the following sections:\n';
  prompt += '1. Product Overview\n';
  prompt += '2. Problem Statement\n';
  prompt += '3. Target Users\n';
  prompt += '4. Feature Requirements\n';
  prompt += '5. Constraints and Limitations\n';
  prompt += '6. Success Metrics\n';

  if (options?.includeUserJourneys) {
    prompt += '7. User Journeys\n';
  }

  if (options?.includeTechnicalConsiderations) {
    prompt += `${
      options.includeUserJourneys ? '8' : '7'
    }. Technical Considerations\n`;
  }

  if (options?.includeTimeline) {
    const nextNum =
      (options.includeUserJourneys ? 1 : 0) +
      (options.includeTechnicalConsiderations ? 1 : 0) +
      7;
    prompt += `${nextNum}. Implementation Timeline\n`;
  }

  prompt +=
    '\nFormat the document using Markdown syntax. Be specific, detailed, and focused on user value.';

  return prompt;
}
