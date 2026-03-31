import { classifySearchIntent } from '../src/company/orchestration/search-intent-classifier';

type HarnessCase = {
  message: string;
  assert: (intent: Awaited<ReturnType<typeof classifySearchIntent>>) => string | null;
};

const normalize = (value: string | null | undefined): string =>
  (value ?? '').trim().toLowerCase();

const cases: HarnessCase[] = [
  {
    message: 'search for human ai llc',
    assert: (intent) =>
      intent.queryType === 'company_entity' && normalize(intent.extractedEntity) === 'human ai llc'
        ? null
        : `expected company_entity + Human AI LLC, got ${JSON.stringify(intent)}`,
  },
  {
    message: 'search in books for human ai llc',
    assert: (intent) =>
      intent.queryType === 'company_entity' && intent.sourceHint === 'books'
        ? null
        : `expected company_entity + books sourceHint, got ${JSON.stringify(intent)}`,
  },
  {
    message: 'bakaya list do',
    assert: (intent) =>
      intent.queryType === 'financial_record' && intent.language === 'mixed'
        ? null
        : `expected financial_record + mixed, got ${JSON.stringify(intent)}`,
  },
  {
    message: '1 April 2025 se 31 March 2026 tak all overdue',
    assert: (intent) =>
      intent.queryType === 'financial_record'
      && intent.dateRange?.from === '2025-04-01'
      && intent.dateRange?.to === '2026-03-31'
        ? null
        : `expected financial_record + parsed dateRange, got ${JSON.stringify(intent)}`,
  },
  {
    message: '@Divo',
    assert: (intent) =>
      intent.isBareMention === true
        ? null
        : `expected isBareMention=true, got ${JSON.stringify(intent)}`,
  },
  {
    message: 'retry',
    assert: (intent) =>
      intent.isContinuation === true
        ? null
        : `expected isContinuation=true, got ${JSON.stringify(intent)}`,
  },
  {
    message: 'use search context for it',
    assert: (intent) =>
      intent.inheritEntityFromThread === true
        ? null
        : `expected inheritEntityFromThread=true, got ${JSON.stringify(intent)}`,
  },
];

const main = async () => {
  const failures: string[] = [];
  for (const testCase of cases) {
    const intent = await classifySearchIntent(testCase.message);
    const failure = testCase.assert(intent);
    if (failure) {
      failures.push(`- ${testCase.message}: ${failure}`);
      continue;
    }
    console.log(`PASS ${testCase.message}`);
  }

  if (failures.length > 0) {
    console.error('Search intent harness failed:');
    for (const failure of failures) {
      console.error(failure);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`All ${cases.length} search intent harness cases passed.`);
};

void main();
