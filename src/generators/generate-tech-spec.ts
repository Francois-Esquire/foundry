import { v4 as uuidv4 } from 'uuid';
import { DocumentType } from './generator';

// Generator agent interface (minimal definition)
export interface GeneratorAgent {
  generate(
    prompt: string,
    options: { maxTokens?: number; temperature?: number }
  ): Promise<string>;
}

// Technical specification options
export interface TechSpecOptions {
  title?: string;
  maxTokens?: number;
  temperature?: number;
  includeArchitecture?: boolean;
  includeAPISpec?: boolean;
  includeSecurityConsiderations?: boolean;
}

// Technical specification document structure
export interface TechSpecDocument {
  id: string;
  type: string;
  title: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, any>;
}

/**
 * Generates a Technical Specification document based on requirements
 *
 * @param agent The generator agent that will create the content
 * @param requirements The requirements to base the technical specification on
 * @param options Optional generation parameters
 * @returns The generated Technical Specification document (not yet saved)
 */
export async function generateTechSpec(
  agent: GeneratorAgent,
  requirements: string,
  options?: TechSpecOptions
): Promise<TechSpecDocument> {
  // Prepare the prompt for technical specification generation
  const prompt = prepareTechSpecPrompt(requirements, options);

  // Generate the technical specification content
  const content = await agent.generate(prompt, {
    maxTokens: options?.maxTokens || 4000,
    temperature: options?.temperature || 0.7,
  });

  // Create document object
  return {
    id: uuidv4(),
    type: DocumentType.TECHNICAL_SPEC,
    title: options?.title || `Technical Specification`,
    content,
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata: {
      requirements,
      generationOptions: options,
    },
  };
}

/**
 * Prepares the prompt for technical specification generation
 */
function prepareTechSpecPrompt(
  requirements: string,
  options?: TechSpecOptions
): string {
  let prompt = `Generate a detailed Technical Specification based on the following requirements: "${requirements}".\n\n`;

  prompt += 'Include the following sections:\n';
  prompt += '1. Overview and Goals\n';
  prompt += '2. System Requirements\n';
  prompt += '3. Dependencies\n';
  prompt += '4. Technical Implementation Details\n';

  if (options?.includeArchitecture) {
    prompt += '5. Architecture Design\n';
  }

  if (options?.includeAPISpec) {
    prompt += `${options.includeArchitecture ? '6' : '5'}. API Specification\n`;
  }

  if (options?.includeSecurityConsiderations) {
    const nextNum =
      (options.includeArchitecture ? 1 : 0) +
      (options.includeAPISpec ? 1 : 0) +
      5;
    prompt += `${nextNum}. Security Considerations\n`;
  }

  prompt +=
    '\nFormat the document using Markdown syntax. Be specific, technically accurate, and implementation-focused.';

  return prompt;
}
