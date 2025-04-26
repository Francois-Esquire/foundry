import type { Document } from './generator';
import { DocumentType } from './generator';

/**
 * Formats a document with front matter and content for storage
 */
export function formatDocumentContent(document: Document): string {
  // Create front matter
  let frontMatter = [
    '---',
    `title: ${document.title}`,
    `type: ${document.type}`,
    `createdAt: ${document.createdAt.toISOString()}`,
    `updatedAt: ${document.updatedAt.toISOString()}`,
  ];

  // Add metadata fields to front matter
  for (const [key, value] of Object.entries(document.metadata)) {
    if (typeof value === 'string') {
      frontMatter.push(`${key}: ${value}`);
    } else {
      // For complex objects, we could use JSON.stringify, but that may not be ideal for front matter
      // For simplicity, we'll skip complex objects here
    }
  }

  frontMatter.push('---');

  // Combine front matter with document content
  return `${frontMatter.join('\n')}\n\n${document.content}`;
}

/**
 * Parses a document string with front matter into a Document object
 */
export function parseDocumentContent(
  content: string,
  id: string
): Document | null {
  try {
    // Parse markdown content with front matter
    const frontMatterMatch = content.match(
      /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/
    );

    if (!frontMatterMatch) {
      console.error('Invalid document format: Missing front matter');
      return null;
    }

    const frontMatter = frontMatterMatch[1];
    const documentContent = frontMatterMatch[2];

    if (frontMatter === undefined || documentContent === undefined) {
      console.error('Invalid document format: Failed to extract content');
      return null;
    }

    // Extract fields from front matter
    const title = extractField(frontMatter, 'title') || 'Untitled Document';
    const typeStr = extractField(frontMatter, 'type');
    const type = typeStr ? (typeStr as DocumentType) : DocumentType.CONCEPT;

    const createdAtStr = extractField(frontMatter, 'createdAt');
    const createdAt = createdAtStr ? new Date(createdAtStr) : new Date();

    const updatedAtStr = extractField(frontMatter, 'updatedAt');
    const updatedAt = updatedAtStr ? new Date(updatedAtStr) : new Date();

    // Parse metadata from front matter
    const metadata: Record<string, any> = {};
    const lines = frontMatter.split('\n');

    for (const line of lines) {
      if (
        line.includes(':') &&
        !line.startsWith('title:') &&
        !line.startsWith('type:') &&
        !line.startsWith('createdAt:') &&
        !line.startsWith('updatedAt:')
      ) {
        const [key, value] = line.split(':', 2);
        if (key && value) {
          metadata[key.trim()] = value.trim();
        }
      }
    }

    return {
      id,
      type,
      title,
      content: documentContent.trim(),
      createdAt,
      updatedAt,
      metadata,
    };
  } catch (error) {
    console.error('Error parsing document content:', error);
    return null;
  }
}

/**
 * Extracts a field from front matter
 */
function extractField(frontMatter: string, fieldName: string): string | null {
  const match = frontMatter.match(new RegExp(`${fieldName}:\\s*(.+)\\s*`));
  return match && match[1] ? match[1].trim() : null;
}
