import assert from 'node:assert/strict';

import {
  applyActionResultToTaskState,
  buildTaskStateContext,
  buildThreadSummaryContext,
  buildDeterministicThreadSummary,
  createEmptyTaskState,
  type DesktopTaskState,
  updateTaskStateFromToolEnvelope,
} from '../src/modules/desktop-chat/desktop-thread-memory';
import type { VercelToolEnvelope } from '../src/company/orchestration/vercel/types';

type ToolCase = {
  name: string;
  toolName: string;
  latestObjective?: string;
  initialState?: DesktopTaskState;
  output: VercelToolEnvelope;
  verify?: (state: DesktopTaskState) => void;
};

type ActionCase = {
  name: string;
  initialState: DesktopTaskState;
  actionResult: {
    kind: string;
    ok: boolean;
    summary: string;
    payload?: Record<string, unknown>;
  };
  verify?: (state: DesktopTaskState) => void;
};

const runToolCase = (testCase: ToolCase): DesktopTaskState => {
  const state = updateTaskStateFromToolEnvelope({
    taskState: testCase.initialState ?? createEmptyTaskState(),
    toolName: testCase.toolName,
    output: testCase.output,
    latestObjective: testCase.latestObjective ?? 'validate shared task state',
  });
  assert.ok(state.updatedAt, `${testCase.name}: updatedAt missing`);
  assert.ok(typeof state.stateVersion === 'number', `${testCase.name}: stateVersion missing`);
  testCase.verify?.(state);
  return state;
};

const runActionCase = (testCase: ActionCase): DesktopTaskState => {
  const state = applyActionResultToTaskState({
    taskState: testCase.initialState,
    actionResult: testCase.actionResult,
  });
  assert.ok(state.updatedAt, `${testCase.name}: updatedAt missing`);
  assert.ok(state.latestActionResult, `${testCase.name}: latestActionResult missing`);
  testCase.verify?.(state);
  return state;
};

const booksReadWorkingSet = runToolCase({
  name: 'booksRead working set',
  toolName: 'booksRead',
  latestObjective: 'show me invoices',
  output: {
    success: true,
    summary: 'Fetched invoices.',
    keyData: {
      module: 'invoices',
      organizationId: 'org_123',
    },
    fullPayload: {
      organizationId: 'org_123',
      records: [
        { invoice_id: 'inv_1', invoice_number: 'INV-001' },
        { invoice_id: 'inv_2', invoice_number: 'INV-002' },
      ],
    },
  },
  verify: (state) => {
    assert.equal(state.activeDomain, 'zoho-books');
    assert.equal(state.activeModule, 'invoices');
    assert.equal(state.workingSets.invoices?.recordIds.length, 2);
    assert.equal(state.aliases['inv_1']?.recordId, 'inv_1');
  },
});

runToolCase({
  name: 'booksRead single record',
  toolName: 'booksRead',
  latestObjective: 'get estimate qt-7',
  output: {
    success: true,
    summary: 'Fetched estimate.',
    keyData: {
      module: 'estimates',
      recordId: 'est_7',
    },
    fullPayload: {
      estimate_number: 'QT-000007',
    },
  },
  verify: (state) => {
    assert.equal(state.currentEntity?.recordId, 'est_7');
    assert.equal(state.currentEntity?.module, 'estimates');
  },
});

runToolCase({
  name: 'larkTask non-books success',
  toolName: 'larkTask',
  latestObjective: 'show my tasks',
  output: {
    success: true,
    summary: 'Found 4 tasks.',
    keyData: {
      items: [{ id: 'task_1' }],
      operation: 'listMine',
    },
  },
  verify: (state) => {
    assert.equal(state.toolJournal.at(-1)?.toolName, 'larkTask');
    assert.equal(state.toolJournal.at(-1)?.recordId, undefined);
  },
});

runToolCase({
  name: 'workflow-authoring schedule success',
  toolName: 'workflowAuthoring',
  latestObjective: 'tell me a joke every day at 1:06 am ist',
  output: {
    success: true,
    summary: 'Created scheduled workflow Joke Daily.',
    keyData: {
      workflowId: 'wf_1',
      operation: 'scheduleWorkflow',
      scheduleType: 'daily',
    },
    fullPayload: {
      workflow: {
        id: 'wf_1',
        name: 'Joke Daily',
      },
    },
  },
  verify: (state) => {
    assert.equal(state.toolJournal.at(-1)?.toolName, 'workflowAuthoring');
    assert.equal(state.toolJournal.at(-1)?.recordId, undefined);
  },
});

runToolCase({
  name: 'document OCR missing input',
  toolName: 'documentOcrRead',
  latestObjective: 'read the pdf',
  output: {
    success: false,
    summary: 'fileAssetId_or_fileName is required.',
    errorKind: 'missing_input',
    fullPayload: {
      missingFields: ['fileAssetId_or_fileName'],
    },
  },
  verify: (state) => {
    assert.equal(state.toolJournal.at(-1)?.ok, false);
  },
});

runToolCase({
  name: 'docSearch stores artifacts',
  toolName: 'docSearch',
  latestObjective: 'search internal docs',
  output: {
    success: true,
    summary: 'Found 2 matching documents.',
    fullPayload: {
      matches: [
        { sourceId: 'file_1', fileName: 'HF Setup.pdf' },
        { sourceId: 'file_2', fileName: 'Architecture Notes.pdf' },
      ],
    },
  },
  verify: (state) => {
    assert.equal(state.activeSourceArtifacts.length, 2);
  },
});

const booksWritePending = runToolCase({
  name: 'booksWrite pending approval',
  toolName: 'booksWrite',
  latestObjective: 'email invoice 19',
  output: {
    success: true,
    summary: 'Approval required to email invoice.',
    pendingApprovalAction: {
      kind: 'tool_action',
      approvalId: 'approval_1',
      scope: 'backend_remote',
      toolId: 'zoho-books-write',
      actionGroup: 'send',
      operation: 'emailInvoice',
      title: 'Email invoice',
      summary: 'Approval required to email invoice inv_19.',
      payload: {
        module: 'invoices',
        invoiceId: 'inv_19',
        body: {
          subject: 'Review invoice',
        },
      },
    },
  },
  verify: (state) => {
    assert.equal(state.pendingApproval?.operation, 'emailInvoice');
    assert.equal(state.pendingApproval?.recordId, 'inv_19');
  },
});

runActionCase({
  name: 'approved books action completion',
  initialState: booksWritePending,
  actionResult: {
    kind: 'tool_action',
    ok: true,
    summary: 'Invoice emailed successfully.',
    payload: {
      invoice: {
        invoice_id: 'inv_19',
        invoice_number: 'INV-000019',
      },
    },
  },
  verify: (state) => {
    assert.equal(state.pendingApproval, null);
    assert.equal(state.currentEntity?.recordId, 'inv_19');
    assert.equal(state.completedMutations.at(-1)?.recordId, 'inv_19');
  },
});

runActionCase({
  name: 'non-pending workflow action result',
  initialState: createEmptyTaskState(),
  actionResult: {
    kind: 'tool_action',
    ok: true,
    summary: 'Scheduled workflow created.',
    payload: {
      workflowId: 'wf_1',
    },
  },
  verify: (state) => {
    assert.equal(state.toolJournal.at(-1)?.recordId, undefined);
    assert.equal(state.pendingApproval, null);
  },
});

const aiVisibleTaskState = buildTaskStateContext(booksWritePending);
assert.ok(aiVisibleTaskState?.includes('Confirmed tool output memory:'), 'task context should keep confirmed tool outputs');
assert.ok(!aiVisibleTaskState?.includes('pendingApproval='), 'task context should not expose raw pending approval hooks');
assert.ok(!aiVisibleTaskState?.includes('Carry-over approval memory'), 'task context should not expose pending approval memory');
assert.ok(!aiVisibleTaskState?.includes('Recent objective memory'), 'task context should not expose active objective hooks');

const summaryState = buildDeterministicThreadSummary({
  messages: [
    { role: 'user', content: 'show me invoices' },
    { role: 'assistant', content: 'Here are the invoices.' },
    { role: 'user', content: 'email the 19th invoice to Anish' },
  ],
  taskState: booksWritePending,
  currentSummary: {
    summary: 'Legacy stale summary mentioning pending approvals.',
    latestObjective: 'old objective',
    latestUserGoal: 'old goal',
    userGoals: [],
    activeEntities: ['source:legacy.png'],
    resolvedReferences: ['1 -> invoices:inv_19 (INV-000019)'],
    completedActions: ['Fetched invoices.'],
    completedWrites: [],
    pendingApprovals: ['Approval required to email invoice inv_19.'],
    constraints: ['Active source artifact: legacy.png'],
    sourceMessageCount: 3,
    updatedAt: new Date().toISOString(),
  },
});

const aiVisibleThreadSummary = buildThreadSummaryContext(summaryState);
assert.ok(aiVisibleThreadSummary?.includes('Summary memory:'), 'thread summary should keep compact narrative');
assert.ok(aiVisibleThreadSummary?.includes('Deterministic reference memory:'), 'thread summary should keep deterministic refs');
assert.ok(!aiVisibleThreadSummary?.includes('Pending approval memory'), 'thread summary should not expose pending approval hooks');
assert.ok(!aiVisibleThreadSummary?.includes('Latest objective memory'), 'thread summary should not expose objective hooks');
assert.ok(!aiVisibleThreadSummary?.includes('Active entity memory'), 'thread summary should not expose active entity hooks');

console.log('shared-task-state-ok');
