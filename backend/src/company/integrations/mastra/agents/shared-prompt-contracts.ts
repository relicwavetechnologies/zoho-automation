type PromptArchitectureInput = {
  identity: string;
  mission: string;
  contractType: 'router' | 'specialist' | 'action/status' | 'formatter/synthesis';
  scope: string[];
  successCriteria: string[];
  tools?: string[];
  workflow?: string[];
  outputContract: string[];
  failureBehavior: string[];
  brevityBudget: string[];
  stopConditions: string[];
};

const formatSection = (title: string, lines: string[]): string => {
  const normalized = lines.map((line) => line.trim()).filter((line) => line.length > 0);
  return normalized.length > 0
    ? [`### ${title}`, ...normalized.map((line) => `- ${line}`)].join('\n')
    : '';
};

export const COMMON_GROUNDING_RULES = [
  'Only claim work that actually happened in this task.',
  'Never fabricate tool results, records, URLs, citations, or completion state.',
  'If the available context is insufficient, say exactly what is missing and stop.',
];

export const TERSE_ACTION_STATUS_RULES = [
  'Return only the status, the concrete artifact or failure reason, and the next relevant identifier or URL.',
  'Do not add narrative explanation, hidden reasoning, or friendly filler.',
];

export const JSON_ONLY_RULES = [
  'Return JSON only.',
  'Do not wrap JSON in markdown fences.',
  'Do not add commentary before or after the JSON object.',
];

export function buildPromptArchitecture(input: PromptArchitectureInput): string {
  return [
    `You are ${input.identity}.`,
    '',
    formatSection('Role And Scope', [
      `Contract type: ${input.contractType}.`,
      input.mission,
      ...input.scope,
    ]),
    formatSection('Success Definition', input.successCriteria),
    formatSection('Allowed Tools And Inputs', input.tools ?? []),
    formatSection('Required Workflow', input.workflow ?? []),
    formatSection('Output Contract', input.outputContract),
    formatSection('Failure Behavior', input.failureBehavior),
    formatSection('Brevity Budget', input.brevityBudget),
    formatSection('Stop Conditions', input.stopConditions),
  ].filter(Boolean).join('\n\n');
}

export function buildJsonOnlyOutputContract(input: {
  shape: string;
  validExample: string;
  invalidExample: string;
  extraRules?: string[];
}): string {
  return formatSection('Structured Output Contract', [
    ...JSON_ONLY_RULES,
    `Required shape: ${input.shape}`,
    `Valid example: ${input.validExample}`,
    `Invalid example to avoid: ${input.invalidExample}`,
    ...(input.extraRules ?? []),
  ]);
}
