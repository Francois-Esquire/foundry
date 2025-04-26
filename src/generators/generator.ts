import type { ServiceRegistry } from '../core/registry';
import { generatePRD } from './generate-prd';
import { generateUserJourney } from './generate-user-journey';
import { generateTechSpec } from './generate-tech-spec';
import { formatDocumentContent, parseDocumentContent } from './formatters';
import type { LanguageModel } from 'ai';
// Document type enum
export enum DocumentType {
  CONCEPT = 'concept',
  USER_JOURNEY = 'user-journey',
  PRD = 'prd',
  TECHNICAL_SPEC = 'technical-spec',
  API_SPEC = 'api-spec',
  ARCHITECTURE = 'architecture',
}

// Document model
export interface Document {
  id: string;
  type: DocumentType;
  title: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, any>;
}

// Document summary
export interface DocumentSummary {
  id: string;
  type: DocumentType;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  model?: string;
}

// PRD generation options
export interface PRDOptions {
  title?: string;
  maxTokens?: number;
  temperature?: number;
  model?: string;
  includeUserJourneys?: boolean;
  includeTechnicalConsiderations?: boolean;
  includeTimeline?: boolean;
}

// Technical specification options
export interface TechSpecOptions {
  title?: string;
  maxTokens?: number;
  temperature?: number;
  includeArchitecture?: boolean;
  includeAPISpec?: boolean;
  includeSecurityConsiderations?: boolean;
  model?: string;
}

// Document generator interface
export interface DocumentGenerator {
  // Document Generation
  generatePRD(concept: string, options?: PRDOptions): Promise<Document>;
  generateUserJourney(persona: string, scenario: string): Promise<Document>;
  generateTechnicalSpec(
    requirements: string,
    options?: TechSpecOptions
  ): Promise<Document>;

  // Document Operations
  getDocument(id: string): Promise<Document | null>;
  saveDocument(document: Document): Promise<Document>;
  listDocuments(type: DocumentType): Promise<DocumentSummary[]>;
}

// Document generator implementation
export class DocumentGeneratorImpl implements DocumentGenerator {
  private serviceRegistry: ServiceRegistry;

  constructor(serviceRegistry: ServiceRegistry) {
    this.serviceRegistry = serviceRegistry;
  }

  async generatePRD(concept: string, options?: PRDOptions): Promise<Document> {
    // Get the generator agent
    const agent = this.serviceRegistry.getAgent('generator');
    const model = agent.languageModel(options?.model || 'gpt-4o');
    // Use the functional generator
    const document = await generatePRD(model, concept, options);

    // Save the document
    return this.saveDocument(document as Document);
  }

  async generateUserJourney(
    persona: string,
    scenario: string,
    options?: { model?: string }
  ): Promise<Document> {
    // Get the generator agent
    const agent = this.serviceRegistry.getAgent('generator');
    const model = agent.languageModel(options?.model || 'gpt-4o');

    // Use the functional generator
    const document = await generateUserJourney(model, persona, scenario);

    // Save the document
    return this.saveDocument(document as Document);
  }

  async generateTechnicalSpec(
    requirements: string,
    options?: TechSpecOptions
  ): Promise<Document> {
    // Get the generator agent
    const agent = this.serviceRegistry.getAgent('generator');
    const model = agent.languageModel(options?.model || 'gpt-4o');

    // Use the functional generator
    const document = await generateTechSpec(model, requirements, options);

    // Save the document
    return this.saveDocument(document as Document);
  }

  async getDocument(id: string): Promise<Document | null> {
    const adapter = this.serviceRegistry.getAdapter('default');

    // Check if document exists
    const documentPath = `documents/${id}.md`;
    if (!(await adapter.exists(documentPath))) {
      return null;
    }

    // Read document file
    const result = await adapter.read(documentPath);
    if (!result) return null;

    // Parse document content using the formatter utility
    return parseDocumentContent(result.content, id);
  }

  async saveDocument(document: Document): Promise<Document> {
    const adapter = this.serviceRegistry.getAdapter('default');

    // Create documents directory if it doesn't exist
    if (!(await adapter.exists('documents'))) {
      await adapter.createDirectory('documents');
    }

    // Create directory for document type if it doesn't exist
    const typeDir = `documents/${document.type}`;
    if (!(await adapter.exists(typeDir))) {
      await adapter.createDirectory(typeDir);
    }

    // Format document as markdown with front matter using the formatter utility
    const content = formatDocumentContent(document);

    // Write document file
    await adapter.write(
      `${typeDir}/${document.id}.md`,
      content,
      'text/markdown'
    );

    return document;
  }

  async listDocuments(type: DocumentType): Promise<DocumentSummary[]> {
    const adapter = this.serviceRegistry.getAdapter('default');

    // Path for document type directory
    const typeDir = `documents/${type}`;

    // Check if directory exists
    if (!(await adapter.exists(typeDir))) {
      return [];
    }

    // List files in directory
    const files = await adapter.list(typeDir);

    // Read each document file and extract summary info
    const summaries = await Promise.all(
      files
        .filter(file => file.endsWith('.md'))
        .map(async file => {
          const result = await adapter.read(`${typeDir}/${file}`);
          if (!result) return null;

          // Parse document to extract summary information using the formatter utility
          const document = parseDocumentContent(
            result.content,
            file.replace('.md', '')
          );
          if (!document) return null;

          return {
            id: document.id,
            type: document.type,
            title: document.title,
            createdAt: document.createdAt,
            updatedAt: document.updatedAt,
          };
        })
    );

    // Filter out nulls
    return summaries.filter(
      (summary): summary is DocumentSummary => summary !== null
    );
  }
}
