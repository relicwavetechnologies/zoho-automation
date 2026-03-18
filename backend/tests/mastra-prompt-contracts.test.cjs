const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const readSource = (relativePath) =>
  fs.readFileSync(path.join(__dirname, '..', 'src', ...relativePath.split('/')), 'utf8');

test('Mastra supervisor prompt is branded as Divo and keeps hard grounding rules', () => {
  const source = readSource('company/integrations/mastra/agents/supervisor.agent.ts');
  assert.match(source, /name: 'Divo'/);
  assert.match(source, /Do not restate the hidden plan/i);
  assert.match(source, /Call at most one tool per turn/i);
  assert.match(source, /Never say a document was created/i);
});

test('Mastra search prompt enforces short grounded outputs', () => {
  const source = readSource('company/integrations/mastra/agents/search.agent.ts');
  assert.match(source, /name: 'Divo Search'/);
  assert.match(source, /Answer only from retrieved context/i);
  assert.match(source, /Target 2 short paragraphs or 3 to 5 bullets maximum/i);
});

test('Mastra lark doc prompt is action/status oriented', () => {
  const source = readSource('company/integrations/mastra/agents/lark-doc-specialist.agent.ts');
  assert.match(source, /contractType: 'action\/status'/i);
  assert.match(source, /one line/i);
  assert.match(source, /Created Lark Doc: <url>/i);
});

test('Mastra planner prompt demands strict JSON contract', () => {
  const source = readSource('company/integrations/mastra/agents/planner.agent.ts');
  assert.match(source, /Return only the required JSON object/i);
  assert.match(source, /validExample:/);
  assert.match(source, /invalidExample:/);
});

test('Mastra ack prompt keeps the terse Divo budget', () => {
  const source = readSource('company/integrations/mastra/agents/ack.agent.ts');
  assert.match(source, /Divo AI/i);
  assert.match(source, /under 12 words/i);
  assert.match(source, /plain text only/i);
});
