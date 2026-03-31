import { classifySearchIntent } from '../src/company/orchestration/search-intent-classifier';
import {
  computeInternalLimit,
  computeSourceWeights,
  getAuthorityLevel,
  isEntityConsistentResult,
  rankContextSearchResults,
  selectInitialSources,
  type ContextSearchBrokerResult,
  type ContextSearchBrokerSourceKey,
} from '../src/company/retrieval/context-search-broker.service';

const ROUND2_SOURCE_ORDER: ContextSearchBrokerSourceKey[] = [
  'zohoBooksLive',
  'zohoCrmContext',
  'files',
  'workspace',
  'personalHistory',
  'larkContacts',
];

const SOURCE_KEYS: ContextSearchBrokerSourceKey[] = [
  'personalHistory',
  'files',
  'larkContacts',
  'zohoCrmContext',
  'zohoBooksLive',
  'workspace',
  'web',
  'skills',
];

type HarnessScenario = {
  message: string;
  sourceResults: Partial<Record<ContextSearchBrokerSourceKey, ContextSearchBrokerResult[]>>;
  assert: (outcome: SimulatedOutcome) => void;
};

type SimulatedOutcome = {
  checkedSources: ContextSearchBrokerSourceKey[];
  webEnabled: boolean;
  round2Enabled: ContextSearchBrokerSourceKey[];
  finalResults: ContextSearchBrokerResult[];
  searchSummary: string;
};

const buildSources = (): Record<ContextSearchBrokerSourceKey, boolean> =>
  Object.fromEntries(SOURCE_KEYS.map((key) => [key, false])) as Record<ContextSearchBrokerSourceKey, boolean>;

const buildCoverage = (sources: Record<ContextSearchBrokerSourceKey, boolean>) =>
  Object.fromEntries(SOURCE_KEYS.map((key) => [key, { enabled: sources[key] }])) as Record<ContextSearchBrokerSourceKey, { enabled: boolean }>;

const makeResult = (overrides: Partial<ContextSearchBrokerResult>): ContextSearchBrokerResult => ({
  scope: 'zoho_books',
  sourceType: 'books_contact',
  sourceId: 'source-1',
  chunkIndex: 0,
  score: 1,
  excerpt: '',
  chunkRef: 'ref',
  sourceLabel: 'label',
  title: '',
  ...overrides,
});

const assert = (condition: boolean, message: string) => {
  if (!condition) {
    throw new Error(message);
  }
};

const simulateSearch = async (
  message: string,
  sourceResults: Partial<Record<ContextSearchBrokerSourceKey, ContextSearchBrokerResult[]>>,
): Promise<SimulatedOutcome> => {
  const intent = await classifySearchIntent(message);
  const weights = computeSourceWeights(intent);
  const requestedLimit = 5;
  const internalLimit = computeInternalLimit(intent, requestedLimit);
  const sources = buildSources();
  selectInitialSources(intent, weights, sources);
  const sourceCoverage = buildCoverage(sources);
  const results: ContextSearchBrokerResult[] = [];

  const runSources = (keys: ContextSearchBrokerSourceKey[]) => {
    for (const key of keys) {
      if (!sourceCoverage[key].enabled) {
        sourceCoverage[key].enabled = true;
      }
      results.push(...(sourceResults[key] ?? []));
    }
  };

  const rerank = () => rankContextSearchResults(results, {
    query: message,
    limit: internalLimit,
    companyLookup: intent.queryType === 'company_entity',
    weights,
  });

  runSources(SOURCE_KEYS.filter((key) => sources[key]));

  let topResults = rerank();
  let consistentResults = topResults.filter((result) => isEntityConsistentResult(result, intent));

  const round2Enabled = ROUND2_SOURCE_ORDER.filter((key) => weights[key] > 0 && !sourceCoverage[key].enabled);
  if (consistentResults.length === 0 && round2Enabled.length > 0) {
    runSources(round2Enabled);
    topResults = rerank();
    consistentResults = topResults.filter((result) => isEntityConsistentResult(result, intent));
  }

  if (consistentResults.length === 0 && weights.web > 0 && !sourceCoverage.web.enabled) {
    runSources(['web']);
    topResults = rerank();
    consistentResults = topResults.filter((result) => isEntityConsistentResult(result, intent));
  }

  const finalResults = consistentResults
    .slice(0, requestedLimit)
    .map((result) => ({
      ...result,
      authorityLevel: getAuthorityLevel(result.scope),
    }));

  const checkedSources = SOURCE_KEYS.filter((key) => sourceCoverage[key].enabled);
  const searchSummary = finalResults.length > 0
    ? `Found ${finalResults.length} result(s) matching "${intent.extractedEntity ?? message}" across ${checkedSources.join(', ')}.`
    : `No matching records found for "${intent.extractedEntity ?? message}". Checked: ${checkedSources.join(', ')}.`;

  return {
    checkedSources,
    webEnabled: sourceCoverage.web.enabled,
    round2Enabled,
    finalResults,
    searchSummary,
  };
};

const scenarios: HarnessScenario[] = [
  {
    message: 'search for HUMANi AI LLC',
    sourceResults: {
      zohoBooksLive: [
        makeResult({
          scope: 'zoho_books',
          sourceType: 'books_contact',
          sourceId: 'books-humani',
          title: 'HUMANi AI LLC',
          excerpt: 'HUMANi AI LLC customer record',
          score: 0.96,
        }),
      ],
    },
    assert: (outcome) => {
      assert(outcome.finalResults.length > 0, 'books hit should succeed in round 1');
      assert(outcome.checkedSources.includes('zohoBooksLive'), 'books should be checked');
      assert(outcome.webEnabled === false, 'web should never be queried when books succeeds');
    },
  },
  {
    message: 'search for human ai llc',
    sourceResults: {
      zohoCrmContext: [
        makeResult({
          scope: 'zoho_crm',
          sourceType: 'crm_account',
          sourceId: 'crm-humani',
          title: 'Human AI LLC',
          excerpt: 'Human AI LLC account in CRM',
          score: 0.84,
        }),
      ],
    },
    assert: (outcome) => {
      assert(outcome.round2Enabled.includes('zohoCrmContext'), 'CRM should be enabled in round 2');
      assert(outcome.finalResults.length > 0, 'CRM should satisfy round 2');
      assert(outcome.webEnabled === false, 'web should remain disabled when CRM succeeds');
      assert(outcome.finalResults[0]?.authorityLevel === 'authoritative', 'CRM result should be authoritative');
    },
  },
  {
    message: 'search for anthropic inc',
    sourceResults: {
      web: [
        makeResult({
          scope: 'web',
          sourceType: 'web_result',
          sourceId: 'web-anthropic',
          title: 'Anthropic',
          excerpt: 'Anthropic Inc builds AI systems',
          score: 0.93,
          url: 'https://www.anthropic.com',
        }),
      ],
    },
    assert: (outcome) => {
      assert(outcome.webEnabled === true, 'web should be enabled in round 3');
      assert(outcome.finalResults.length > 0, 'web should provide final result');
      assert(outcome.finalResults[0]?.authorityLevel === 'public', 'web result should be public authority');
    },
  },
  {
    message: 'search for xyzfakecompany999llc',
    sourceResults: {},
    assert: (outcome) => {
      assert(outcome.finalResults.length === 0, 'unknown entity should produce no final results');
      assert(outcome.searchSummary.includes('No matching records found'), 'summary should be explicit not-found');
      assert(outcome.searchSummary.includes('zohoBooksLive'), 'summary should list checked books source');
      assert(outcome.searchSummary.includes('zohoCrmContext'), 'summary should list checked CRM source');
      assert(outcome.searchSummary.includes('web'), 'summary should list checked web source');
    },
  },
  {
    message: 'search for human ai llc',
    sourceResults: {
      zohoCrmContext: [
        makeResult({
          scope: 'zoho_crm',
          sourceType: 'crm_deal',
          sourceId: 'crm-deal-1',
          title: 'StrictScope Deal',
          excerpt: 'A weak unrelated CRM deal',
          score: 0.58,
        }),
      ],
    },
    assert: (outcome) => {
      assert(outcome.finalResults.length === 0, 'weak inconsistent CRM hit should not surface');
      assert(outcome.webEnabled === true, 'broker should escalate to web after rejecting weak CRM hit');
      assert(!outcome.finalResults.some((result) => result.title?.includes('StrictScope')), 'weak CRM hit must not survive');
    },
  },
];

const main = async () => {
  for (const scenario of scenarios) {
    const outcome = await simulateSearch(scenario.message, scenario.sourceResults);
    scenario.assert(outcome);
    console.log(`PASS ${scenario.message}`);
  }

  console.log(`All ${scenarios.length} P2 ladder harness cases passed.`);
};

void main();
