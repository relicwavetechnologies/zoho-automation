import type { FileDocumentClass } from './classify';
import { classifyFileDocument } from './classify';

export const FILE_CHUNKING_STRATEGIES = [
  'canonical_simple',
  'semantic_heading',
  'hybrid_structured',
  'transcript_segment',
] as const;

export type FileChunkingStrategy = (typeof FILE_CHUNKING_STRATEGIES)[number];

export interface FileChunkingPlan {
  documentClass:        FileDocumentClass;
  strategy:             FileChunkingStrategy;
  hierarchical:         boolean;
  contextualEnrichment: boolean;
  childTargetTokens:    number;
  childOverlapTokens:   number;
  parentTargetTokens?:  number;
}

export function chooseFileChunkingPlan(input: {
  fileName: string;
  mimeType: string;
  text: string;
  advancedChunkingEnabled?: boolean;
  contextualEnrichmentEnabled?: boolean;
}): FileChunkingPlan {
  const documentClass = classifyFileDocument(input);
  const advanced = input.advancedChunkingEnabled ?? true;
  const contextual = input.contextualEnrichmentEnabled ?? true;

  if (!advanced || documentClass === 'media_summary') {
    return {
      documentClass,
      strategy: 'canonical_simple',
      hierarchical: false,
      contextualEnrichment: false,
      childTargetTokens: 900,
      childOverlapTokens: 180,
    };
  }

  if (documentClass === 'transcript') {
    return {
      documentClass,
      strategy: 'transcript_segment',
      hierarchical: false,
      contextualEnrichment: false,
      childTargetTokens: 320,
      childOverlapTokens: 48,
    };
  }

  if (
    documentClass === 'policy' ||
    documentClass === 'contract' ||
    documentClass === 'handbook' ||
    documentClass === 'sop'
  ) {
    return {
      documentClass,
      strategy: 'hybrid_structured',
      hierarchical: true,
      contextualEnrichment: contextual,
      childTargetTokens: 480,
      childOverlapTokens: 64,
      parentTargetTokens: 1400,
    };
  }

  if (documentClass === 'finance_doc') {
    return {
      documentClass,
      strategy: 'semantic_heading',
      hierarchical: true,
      contextualEnrichment: contextual,
      childTargetTokens: 560,
      childOverlapTokens: 72,
      parentTargetTokens: 1200,
    };
  }

  return {
    documentClass,
    strategy: 'semantic_heading',
    hierarchical: false,
    contextualEnrichment: false,
    childTargetTokens: 720,
    childOverlapTokens: 96,
  };
}
