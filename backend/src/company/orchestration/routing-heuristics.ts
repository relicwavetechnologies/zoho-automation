import type { AgentResultDTO, NormalizedIncomingMessageDTO, OrchestrationTaskDTO } from '../contracts';
import { ALL_WRITE_LIKE_VERBS, classifyIntent } from './intent/canonical-intent';

/** @deprecated Use classifyIntent() from canonical-intent instead */
export { ALL_WRITE_LIKE_VERBS as WRITE_INTENT_KEYWORDS } from './intent/canonical-intent';
const OUTREACH_QUERY_KEYWORDS = [
  'outreach',
  'publisher',
  'guest post',
  'domain authority',
  'domain rating',
  'da ',
  'dr ',
];
const WEB_SEARCH_QUERY_KEYWORDS = [
  'search',
  'look up',
  'lookup',
  'google',
  'web',
  'website',
  'site',
  'domain',
  'news',
  'latest',
  'current',
  'research',
];

const LARK_DOC_KEYWORDS = [
  'lark doc',
  'lark docs',
  'document',
  'doc',
  'write up',
  'export',
  'save this',
];

const isOutreachQuery = (text: string): boolean => {
  const normalized = text.toLowerCase();
  return OUTREACH_QUERY_KEYWORDS.some((keyword) => normalized.includes(keyword));
};

const isWebSearchQuery = (text: string): boolean => {
  const normalized = text.toLowerCase();
  if (/\bhttps?:\/\/[^\s]+/i.test(text)) {
    return true;
  }
  if (/\bsite:[a-z0-9.-]+\.[a-z]{2,}\b/i.test(text)) {
    return true;
  }
  if (/\b[a-z0-9][a-z0-9.-]*\.[a-z]{2,}\b/i.test(text) && normalized.includes('website')) {
    return true;
  }
  return WEB_SEARCH_QUERY_KEYWORDS.some((keyword) => normalized.includes(keyword));
};

const isLarkDocQuery = (text: string): boolean => {
  const normalized = text.toLowerCase();
  if (!LARK_DOC_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
    return false;
  }
  return /\b(create|make|build|put|save|export|draft|write|edit|update|append|add|remove|delete|rewrite|replace)\b/i.test(text);
};

export const mapDomainToRouteType = (
  domain: string,
): 'zoho_read' | 'write_intent' | 'general' => {
  switch (domain.trim()) {
    case 'zoho_crm':
    case 'outreach':
      return 'zoho_read';
    case 'zoho_books':
    case 'lark_task':
    case 'lark_message':
    case 'lark_calendar':
    case 'lark_meeting':
    case 'lark_approval':
    case 'lark_doc':
    case 'lark_base':
    case 'gmail':
    case 'google_drive':
    case 'google_calendar':
    case 'workflow':
      return 'write_intent';
    default:
      return 'general';
  }
};

export const classifyComplexityLevel = (text: string): 1 | 2 | 3 | 4 | 5 => {
  const normalized = text.toLowerCase();
  if (classifyIntent(text).isWriteLike) {
    return 4;
  }
  if (normalized.includes('sync') || normalized.includes('onboard') || normalized.includes('workflow')) {
    return 3;
  }
  if (normalized.trim().length <= 40) {
    return 1;
  }
  return 2;
};

export const detectRouteIntent = (
  text: string,
  childRouterDomain?: string | null,
): 'zoho_read' | 'write_intent' | 'general' => {
  if (childRouterDomain && childRouterDomain !== 'general') {
    return mapDomainToRouteType(childRouterDomain);
  }
  const intent = classifyIntent(text);
  if (intent.domain === 'zoho_crm' || intent.domain === 'outreach') {
    return 'zoho_read';
  }
  if (intent.domain === 'zoho_books') {
    return 'write_intent';
  }
  if (intent.isWriteLike) {
    return 'write_intent';
  }
  return 'general';
};

export const buildPlanFromIntent = (
  intent: 'zoho_read' | 'write_intent' | 'general',
  complexityLevel: 1 | 2 | 3 | 4 | 5,
  text: string,
): string[] => {
  const normalized = text.toLowerCase();

  if (intent === 'zoho_read') {
    if (isOutreachQuery(normalized)) {
      return ['route.classify', 'agent.invoke.outreach-read', 'agent.invoke.lark-response', 'synthesis.compose'];
    }
    return ['route.classify', 'agent.invoke.zoho-read', 'agent.invoke.lark-response', 'synthesis.compose'];
  }

  if (normalized.includes('unknown_agent')) {
    return ['route.classify', 'agent.invoke.unknown', 'synthesis.compose'];
  }

  if (intent === 'write_intent') {
    const canonicalIntent = classifyIntent(text);
    if (canonicalIntent.domain === 'zoho_books') {
      return [
        'route.classify',
        'agent.invoke.risk-check',
        'agent.invoke.zoho-books-action',
        'agent.invoke.lark-response',
        'synthesis.compose',
      ];
    }
    return [
      'route.classify',
      'agent.invoke.risk-check',
      'agent.invoke.zoho-action',
      'agent.invoke.lark-response',
      'synthesis.compose',
    ];
  }

  if (complexityLevel >= 4) {
    return [
      'route.classify',
      'agent.invoke.risk-check',
      'agent.invoke.zoho-action',
      'agent.invoke.lark-response',
      'synthesis.compose',
    ];
  }

  if (isWebSearchQuery(normalized)) {
    return ['route.classify', 'agent.invoke.search-read', 'agent.invoke.lark-response', 'synthesis.compose'];
  }

  if (isLarkDocQuery(normalized)) {
    return ['route.classify', 'agent.invoke.lark-doc', 'agent.invoke.lark-response', 'synthesis.compose'];
  }

  return ['route.classify', 'agent.invoke.response', 'agent.invoke.lark-response', 'synthesis.compose'];
};

export const requiresHumanConfirmation = (text: string): boolean => {
  return classifyIntent(text).isWriteLike;
};

export const buildHitlSummary = (text: string): string => {
  const summary = text.trim();
  if (summary.length <= 160) {
    return summary;
  }
  return `${summary.slice(0, 157)}...`;
};

export const synthesizeFromAgentResults = (
  task: OrchestrationTaskDTO,
  message: NormalizedIncomingMessageDTO,
  agentResults: AgentResultDTO[],
): { taskStatus: 'done' | 'failed'; text: string } => {
  const failed = agentResults.find((result) => result.status === 'failed');
  if (failed) {
    return {
      taskStatus: 'failed',
      text: `Request could not be completed: ${failed.message}`,
    };
  }

  const zohoResult = agentResults.find((result) => result.agentKey === 'zoho-read' && result.status === 'success');
  if (zohoResult?.result) {
    const answer = typeof zohoResult.result.answer === 'string' && zohoResult.result.answer.trim()
      ? zohoResult.result.answer.trim()
      : undefined;
    const sources = Array.isArray(zohoResult.result.sources)
      ? (zohoResult.result.sources as string[]).slice(0, 3)
      : [];
    const sourceText = sources.length > 0 ? ` Sources: ${sources.join(', ')}.` : '';
    return {
      taskStatus: 'done',
      text: answer ?? `Zoho data read complete.${sourceText}`,
    };
  }

  const actionResult = agentResults.find(
    (result) => (result.agentKey === 'zoho-action' || result.agentKey === 'zoho-books-action') && result.status === 'success',
  );
  if (actionResult?.result) {
    const actionName = typeof actionResult.result.actionName === 'string' ? actionResult.result.actionName : 'action';
    const sources = Array.isArray(actionResult.result.sourceRefs)
      ? (actionResult.result.sourceRefs as Array<{ id?: string }>).map((entry) => entry?.id).filter(Boolean).slice(0, 3)
      : [];
    const sourceText = sources.length > 0 ? ` Sources: ${sources.join(', ')}.` : '';
    return {
      taskStatus: 'done',
      text: `Zoho action '${actionName}' executed.${sourceText}`,
    };
  }

  const outreachResult = agentResults.find(
    (result) => result.agentKey === 'outreach-read' && result.status === 'success',
  );
  if (outreachResult?.result) {
    const answer = typeof outreachResult.result.answer === 'string' ? outreachResult.result.answer.trim() : '';
    const sourceRefs = Array.isArray(outreachResult.result.sourceRefs)
      ? (outreachResult.result.sourceRefs as Array<{ id?: string }>).map((entry) => entry?.id).filter(Boolean).slice(0, 3)
      : [];
    const sourceText = sourceRefs.length > 0 ? ` Sources: ${sourceRefs.join(', ')}.` : '';
    return {
      taskStatus: 'done',
      text: answer.length > 0 ? answer : `Outreach publisher lookup complete.${sourceText}`,
    };
  }

  const searchResult = agentResults.find((result) => result.agentKey === 'search-read' && result.status === 'success');
  if (searchResult?.result) {
    const answer = typeof searchResult.result.answer === 'string' ? searchResult.result.answer.trim() : '';
    const sourceRefs = Array.isArray(searchResult.result.sourceRefs)
      ? (searchResult.result.sourceRefs as Array<{ id?: string }>).map((entry) => entry?.id).filter(Boolean).slice(0, 3)
      : [];
    const sourceText = sourceRefs.length > 0 ? ` Sources: ${sourceRefs.join(', ')}.` : '';
    return {
      taskStatus: 'done',
      text: answer.length > 0 ? answer : `Web search complete.${sourceText}`,
    };
  }

  const larkDocResult = agentResults.find((result) => result.agentKey === 'lark-doc' && result.status === 'success');
  if (larkDocResult?.result) {
    const answer = typeof larkDocResult.result.answer === 'string' ? larkDocResult.result.answer.trim() : '';
    return {
      taskStatus: 'done',
      text: answer.length > 0 ? answer : 'Lark Doc created successfully.',
    };
  }

  return {
    taskStatus: 'done',
    text: `Processed (${task.executionMode}) for message ${message.messageId}. Plan: ${task.plan.join(' -> ')}`,
  };
};
