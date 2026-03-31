import { classifySearchIntent } from '../src/company/orchestration/search-intent-classifier';
import {
  computeSourceWeights,
  rankContextSearchResults,
  selectInitialSources,
  type ContextSearchBrokerResult,
  type ContextSearchBrokerSourceKey,
} from '../src/company/retrieval/context-search-broker.service';

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

const buildSources = (): Record<ContextSearchBrokerSourceKey, boolean> =>
  Object.fromEntries(SOURCE_KEYS.map((key) => [key, false])) as Record<ContextSearchBrokerSourceKey, boolean>;

const enabledSources = (sources: Record<ContextSearchBrokerSourceKey, boolean>): ContextSearchBrokerSourceKey[] =>
  SOURCE_KEYS.filter((key) => sources[key]);

const makeResult = (overrides: Partial<ContextSearchBrokerResult>): ContextSearchBrokerResult => ({
  scope: 'zoho_books',
  sourceType: 'books_contact',
  sourceId: 'source-1',
  chunkIndex: 0,
  score: 1,
  excerpt: 'example',
  chunkRef: 'ref',
  sourceLabel: 'label',
  ...overrides,
});

const assert = (condition: boolean, message: string) => {
  if (!condition) {
    throw new Error(message);
  }
};

const verifySources = async (
  message: string,
  expectedEnabled: ContextSearchBrokerSourceKey[],
  expectedDisabled: ContextSearchBrokerSourceKey[],
) => {
  const intent = await classifySearchIntent(message);
  const weights = computeSourceWeights(intent);
  const sources = buildSources();
  selectInitialSources(intent, weights, sources);

  for (const key of expectedEnabled) {
    assert(sources[key] === true, `"${message}" expected ${key} enabled, got ${JSON.stringify(sources)}`);
  }
  for (const key of expectedDisabled) {
    assert(sources[key] === false, `"${message}" expected ${key} disabled, got ${JSON.stringify(sources)}`);
  }

  console.log(`PASS ${message} -> enabled: ${enabledSources(sources).join(', ') || '(none)'}`);
  return { intent, weights, sources };
};

const main = async () => {
  const companyLookup = await verifySources(
    'search for human ai llc',
    ['zohoBooksLive'],
    ['larkContacts', 'personalHistory', 'web'],
  );

  const companyRanked = rankContextSearchResults([
    makeResult({
      scope: 'lark_contacts',
      sourceType: 'lark_contact',
      sourceId: 'lark-1',
      title: 'Human AI LLC',
      score: 0.99,
    }),
    makeResult({
      scope: 'zoho_books',
      sourceType: 'books_contact',
      sourceId: 'books-1',
      title: 'Human AI LLC',
      score: 0.7,
    }),
  ], {
    query: 'search for human ai llc',
    limit: 10,
    companyLookup: companyLookup.intent.queryType === 'company_entity',
    weights: companyLookup.weights,
  });
  assert(companyRanked.every((result) => result.scope !== 'lark_contacts'), 'company lookup should filter out lark_contacts results');
  console.log('PASS company_entity ranking filters lark_contacts results');

  await verifySources(
    'find anish suman email',
    ['larkContacts', 'zohoBooksLive'],
    ['web'],
  );

  await verifySources(
    'show overdue invoices',
    ['zohoBooksLive'],
    ['web', 'larkContacts', 'personalHistory'],
  );

  const explicitBooks = await verifySources(
    'search in books for human ai llc',
    ['zohoBooksLive'],
    ['zohoCrmContext', 'files', 'workspace', 'web', 'skills', 'larkContacts', 'personalHistory'],
  );
  assert(enabledSources(explicitBooks.sources).length === 1, 'explicit books hint should enable only zohoBooksLive');

  console.log('All 4 P1 source harness cases passed.');
};

void main();
