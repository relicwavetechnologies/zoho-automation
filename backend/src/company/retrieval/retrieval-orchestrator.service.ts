import type { GroundedEvidence, GroundedEvidenceSourceFamily } from './contracts';
import type { RetrievalPlan } from './contracts';
import { retrievalPlannerService } from './retrieval-planner.service';

type OrchestratorInput = {
  messageText: string;
  intent?: string;
  domains?: string[];
  freshnessNeed?: 'none' | 'maybe' | 'required';
  retrievalMode?: 'none' | 'vector' | 'web' | 'both';
  hasAttachments?: boolean;
};

type ToolEnvelopeShape = {
  summary?: string;
  fullPayload?: Record<string, unknown>;
  citations?: Array<Record<string, unknown>>;
};

const pushUnique = (values: string[], value: string) => {
  if (!values.includes(value)) {
    values.push(value);
  }
};

const readString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const inferSourceFamilyFromCitation = (
  toolName: string,
  citation?: Record<string, unknown>,
): GroundedEvidenceSourceFamily => {
  const sourceType = readString(citation?.sourceType);
  if (sourceType?.startsWith('zoho_') || toolName === 'zoho') return 'zoho';
  if (
    sourceType === 'file_document'
    || toolName === 'contextSearch'
    || toolName === 'documentOcrRead'
  ) return 'file';
  if (sourceType === 'chat_turn') return 'chat';
  if (toolName === 'skillSearch' || sourceType === 'skill') return 'skill';
  if (toolName === 'webSearch' || sourceType === 'web' || sourceType === 'web_result') return 'web';
  if (toolName === 'invoiceParser' || toolName === 'statementParser') return 'parser';
  return 'file';
};

const inferStaleRisk = (
  sourceFamily: GroundedEvidenceSourceFamily,
  toolName: string,
): GroundedEvidence['staleRisk'] => {
  if (sourceFamily === 'web') return 'low';
  if (sourceFamily === 'zoho' && toolName === 'zoho') return 'medium';
  if (sourceFamily === 'parser') return 'low';
  if (sourceFamily === 'file') return 'medium';
  return 'low';
};

export class RetrievalOrchestratorService {
  planExecution(input: OrchestratorInput): {
    plan: RetrievalPlan;
    toolFamilies: string[];
    systemDirectives: string[];
  } {
    const plan = retrievalPlannerService.buildPlan(input);
    const toolFamilies: string[] = [];
    const systemDirectives: string[] = [];

    for (const step of plan.steps) {
      if (step.need === 'attachment_exact') {
        pushUnique(toolFamilies, 'contextSearch');
        pushUnique(toolFamilies, 'documentOcrRead');
        systemDirectives.push(
          'Attachment-aware retrieval is active. Ground the answer in the attached/uploaded file context before broader company retrieval.',
        );
      }

      if (step.need === 'company_docs') {
        pushUnique(toolFamilies, 'contextSearch');
        pushUnique(toolFamilies, 'documentOcrRead');
        if (step.strategy === 'doc_full_read') {
          systemDirectives.push(
            'For exact policy wording, clauses, definitions, or exceptions, use contextSearch first and then document OCR/full extraction on the most relevant file.',
          );
        } else {
          systemDirectives.push(
            'Use contextSearch first for indexed internal retrieval. Use OCR/direct file extraction only when chunk retrieval is insufficient.',
          );
        }
      }

      if (step.need === 'workflow_skill') {
        pushUnique(toolFamilies, 'contextSearch');
        systemDirectives.push(
          'This request is workflow-like. Use contextSearch with skill sources first, read the best matching skill, then continue with the domain tool path.',
        );
      }

      if (step.need === 'conversation_memory') {
        systemDirectives.push(
          'Treat conversation memory as contextual support only. Do not use it as the primary source for company facts.',
        );
      }

      if (step.need === 'structured_finance') {
        pushUnique(toolFamilies, 'invoiceParser');
        pushUnique(toolFamilies, 'statementParser');
        pushUnique(toolFamilies, 'documentOcrRead');
        pushUnique(toolFamilies, 'contextSearch');
        systemDirectives.push(
          'Prefer structured parsers for invoice, statement, balance, and transaction questions. Use document retrieval only to supplement missing parsed fields or explain surrounding context.',
        );
      }

      if (step.need === 'crm_entity') {
        pushUnique(toolFamilies, 'zoho');
        systemDirectives.push(
          'For Zoho/CRM questions, use vector retrieval for recall and live CRM reads for current status, dates, owners, stages, amounts, or SLA-sensitive facts.',
        );
      }

      if (step.need === 'hybrid_web') {
        pushUnique(toolFamilies, 'contextSearch');
        systemDirectives.push(
          'Sequence internal retrieval before web retrieval through contextSearch. In the final answer, clearly separate internal evidence from public web evidence.',
        );
      }
    }

    for (const domain of input.domains ?? []) {
      if (domain === 'repo') pushUnique(toolFamilies, 'repo');
      if (domain === 'outreach') pushUnique(toolFamilies, 'outreach');
      if (domain === 'books') pushUnique(toolFamilies, 'booksRead');
      if (domain === 'google') {
        pushUnique(toolFamilies, 'googleMail');
        pushUnique(toolFamilies, 'googleDrive');
        pushUnique(toolFamilies, 'googleCalendar');
      }
      if (domain === 'lark') {
        pushUnique(toolFamilies, 'larkTask');
        pushUnique(toolFamilies, 'larkCalendar');
        pushUnique(toolFamilies, 'larkMeeting');
        pushUnique(toolFamilies, 'larkApproval');
        pushUnique(toolFamilies, 'larkDoc');
        pushUnique(toolFamilies, 'larkBase');
      }
    }

    if ((input.retrievalMode === 'web' || input.retrievalMode === 'both') && !toolFamilies.includes('contextSearch')) {
      pushUnique(toolFamilies, 'contextSearch');
    }

    return {
      plan,
      toolFamilies,
      systemDirectives,
    };
  }

  collectGroundedEvidence(toolName: string, output: ToolEnvelopeShape): GroundedEvidence[] {
    const evidence: GroundedEvidence[] = [];
    const citations = Array.isArray(output.citations) ? output.citations : [];

    for (const citation of citations) {
      const sourceFamily = inferSourceFamilyFromCitation(toolName, citation);
      const title = readString(citation.title) ?? readString(citation.fileName);
      const sourceId = readString(citation.sourceId) ?? readString(citation.fileAssetId) ?? `${toolName}:citation`;
      evidence.push({
        sourceFamily,
        sourceId,
        title,
        excerpt: title ?? output.summary ?? `${toolName} evidence`,
        confidence: typeof citation.score === 'number' ? citation.score : undefined,
        staleRisk: inferStaleRisk(sourceFamily, toolName),
        citation,
      });
    }

    if (evidence.length === 0 && output.fullPayload) {
      const sourceFamily = inferSourceFamilyFromCitation(toolName);
      const payload = output.fullPayload;
      evidence.push({
        sourceFamily,
        sourceId:
          readString(payload.sourceId)
          ?? readString(payload.fileAssetId)
          ?? readString(payload.skillId)
          ?? toolName,
        title:
          readString(payload.fileName)
          ?? readString(payload.title)
          ?? readString(payload.name),
        excerpt: output.summary ?? `${toolName} evidence`,
        staleRisk: inferStaleRisk(sourceFamily, toolName),
        citation: payload,
      });
    }

    return evidence;
  }

  buildPromptGuidance(input: OrchestratorInput): string[] {
    return this.planExecution(input).systemDirectives;
  }
}

export const retrievalOrchestratorService = new RetrievalOrchestratorService();
