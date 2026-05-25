const RED = '\u001b[31m';
const RESET = '\u001b[0m';

export function redModelSelection(input: {
  readonly provider: string;
  readonly modelId: string;
  readonly source: string;
  readonly agentSlug?: string;
}): string {
  const agent = input.agentSlug ? ` agent=${input.agentSlug}` : '';
  return `${RED}AI MODEL SELECTED provider=${input.provider} model=${input.modelId} source=${input.source}${agent}${RESET}`;
}
