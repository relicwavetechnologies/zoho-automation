import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createMockFollowUpsClient, followUpRecordToTask, PLAIN_LARK_LIFECYCLE_ACTIONS } from '@/lib/follow-ups'
import { FollowUpsClientError, type FollowUpLifecycleActions, type FollowUpRecord } from '@/lib/follow-ups/api-types'
import { MOCK_FOLLOW_UP_TASKS } from '@/lib/follow-ups/mock-data'
import { policyJsonFromPreset } from '@/lib/follow-ups/policy-preset'

import { FollowUpActiveBanner } from './active-banner'
import { FollowUpCompleteModal } from './complete-modal'
import { FollowUpCreateModal } from './create-modal'
import { FollowUpsChrome } from './follow-ups-chrome'
import { FollowUpTaskDetailDrawer } from './task-detail-drawer'
import { FollowUpUpdateDocModal } from './update-doc-modal'

const MIXED_PLAIN_LARK_RECORD: FollowUpRecord = {
  id: 'lark:task_plain',
  title: 'Plain Lark task',
  status: 'assigned',
  assignedByName: 'Lark Tasks',
  assigneeName: 'Anish',
  dueLabel: '2026-06-19',
  dueDate: '2026-06-19',
  group: 'upcoming',
  larkTaskGuid: 'task_plain',
  larkTaskUrl: 'https://larksuite.example/task/task_plain',
  followUpPolicyJson: {},
  lifecycleActions: PLAIN_LARK_LIFECYCLE_ACTIONS
}

const ASSIGNED_ASSIGNEE_ACTIONS: FollowUpLifecycleActions = {
  isFollowUp: true,
  canStart: true,
  canPause: false,
  canUpdateDoc: false,
  canComplete: false,
  canReassign: false,
  canOpenTrackingDoc: false,
  requiresCompletionSummary: true
}

const ACTIVE_ASSIGNEE_ACTIONS: FollowUpLifecycleActions = {
  isFollowUp: true,
  canStart: false,
  canPause: true,
  canUpdateDoc: true,
  canComplete: true,
  canReassign: false,
  canOpenTrackingDoc: true,
  requiresCompletionSummary: true
}

const PAUSED_ASSIGNEE_ACTIONS: FollowUpLifecycleActions = {
  isFollowUp: true,
  canStart: true,
  canPause: false,
  canUpdateDoc: false,
  canComplete: false,
  canReassign: false,
  canOpenTrackingDoc: true,
  requiresCompletionSummary: true
}

const MANAGER_ACTIVE_ACTIONS: FollowUpLifecycleActions = {
  isFollowUp: true,
  canStart: false,
  canPause: false,
  canUpdateDoc: false,
  canComplete: false,
  canReassign: true,
  canOpenTrackingDoc: true,
  requiresCompletionSummary: true
}

const MIXED_DIVO_RECORD: FollowUpRecord = {
  id: 'fu_1',
  title: 'Prepare Q2 renewal notes',
  status: 'assigned',
  assignedByName: 'Vira',
  assigneeName: 'Rahul',
  dueLabel: 'Tomorrow EOD',
  dueDate: '2026-06-18',
  group: 'today',
  notes: 'Use CRM context',
  larkTaskGuid: 'task_1',
  larkTaskUrl: 'https://larksuite.example/task/t1',
  delegatedTag: 'Divo Follow Up',
  followUpPolicyJson: policyJsonFromPreset('start_pause_done'),
  lifecycleActions: ASSIGNED_ASSIGNEE_ACTIONS
}

const ACTIVE_DIVO_RECORD: FollowUpRecord = {
  id: 'fu_active',
  title: 'Active follow-up',
  status: 'active',
  assignedByName: 'Vira',
  assigneeName: 'Anish',
  dueLabel: 'Today',
  group: 'today',
  delegatedTag: 'Divo Follow Up',
  trackingDocUrl: 'https://larksuite.example/doc/doc_token_1',
  lifecycleActions: ACTIVE_ASSIGNEE_ACTIONS
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('FollowUpCreateModal', () => {
  it('requires title before create', async () => {
    const submitted: unknown[] = []
    render(
      <FollowUpCreateModal
        onOpenChange={() => undefined}
        onSubmit={async draft => {
          submitted.push(draft)
        }}
        open
      />
    )

    const createButton = screen.getByRole('button', { name: 'Create' })
    expect(createButton.hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Prepare rollout brief' } })
    expect(createButton.hasAttribute('disabled')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => {
      expect(submitted).toHaveLength(1)
    })
    expect(submitted[0]).toMatchObject({
      title: 'Prepare rollout brief',
      assignee: 'anish',
      policyPreset: 'start_pause_done'
    })
    expect(screen.getByText(/creates a tracked follow-up/i)).toBeTruthy()
  })

  it('shows loading label while submitting', () => {
    render(
      <FollowUpCreateModal
        onOpenChange={() => undefined}
        onSubmit={async () => undefined}
        open
        submitting
      />
    )

    expect(screen.getByRole('button', { name: 'Creating…' })).toBeTruthy()
  })

  it('renders submit error message', () => {
    render(
      <FollowUpCreateModal
        errorMessage="Assignee could not be resolved"
        onOpenChange={() => undefined}
        onSubmit={async () => undefined}
        open
      />
    )

    expect(screen.getByText('Assignee could not be resolved')).toBeTruthy()
  })
})

describe('FollowUpsChrome client wiring', () => {
  it('submits create through injected client and reflects created task', async () => {
    const onCreate = vi.fn()
    const client = createMockFollowUpsClient({
      initialTasks: [
        {
          id: 'fu-active',
          title: 'Active seeded task',
          status: 'active',
          assignedByName: 'Vira',
          assigneeName: 'Anish',
          dueLabel: 'Today',
          group: 'today',
          larkTaskUrl: 'https://example.larksuite.com/task/active',
          delegatedTag: 'Divo Follow Up',
          lifecycleActions: ACTIVE_ASSIGNEE_ACTIONS
        }
      ],
      onCreate
    })

    render(<FollowUpsChrome client={client} />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Assign follow-up/i })).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: /Assign follow-up/i }))
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Client wired task' } })
    fireEvent.change(screen.getByPlaceholderText('Notes or reference (optional)'), {
      target: { value: 'Reference notes' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Client wired task',
          assigneeId: 'anish',
          dueDate: 'tomorrow',
          notes: 'Reference notes',
          policyPreset: 'start_pause_done'
        })
      )
    })

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Client wired task' })).toBeTruthy()
    })
  })

  it('shows create error from client without closing modal', async () => {
    const client = createMockFollowUpsClient({
      initialTasks: [],
      failCreateWith: 'Could not resolve assignee'
    })

    render(<FollowUpsChrome client={client} />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Assign follow-up/i })).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: /Assign follow-up/i }))
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Broken create' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => {
      expect(screen.getByText('Could not resolve assignee')).toBeTruthy()
    })
    expect(screen.getByRole('button', { name: 'Create' })).toBeTruthy()
  })

  it('renders backend-shaped follow-up records from the client', async () => {
    const backendRecord: FollowUpRecord = {
      id: 'fu_1',
      title: 'Prepare Q2 renewal notes',
      status: 'assigned',
      assignedByName: 'Vira',
      assigneeName: 'Rahul',
      dueLabel: 'Tomorrow EOD',
      dueDate: '2026-06-18',
      group: 'today',
      notes: 'Use CRM context',
      larkTaskGuid: 'task_1',
      larkTaskUrl: 'https://larksuite.example/task/t1',
      delegatedTag: 'Divo Follow Up',
      followUpPolicyJson: policyJsonFromPreset('start_pause_done'),
      lifecycleActions: ASSIGNED_ASSIGNEE_ACTIONS
    }
    const client = createMockFollowUpsClient({ initialTasks: [backendRecord] })

    render(<FollowUpsChrome client={client} />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Assign follow-up/i })).toBeTruthy()
    })

    const listed = await client.listTaskMetadata()
    expect(listed.tasks[0]?.larkTaskGuid).toBe('task_1')
    expect(listed.tasks[0]?.id).toBe('fu_1')

    render(
      <FollowUpTaskDetailDrawer
        onOpenChange={() => undefined}
        open
        task={followUpRecordToTask(backendRecord)}
      />
    )

    expect(screen.getByRole('heading', { name: 'Prepare Q2 renewal notes' })).toBeTruthy()
    expect(screen.getByText(/From Vira/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Add to context & start/i })).toBeTruthy()
  })

  it('plain Lark lifecycleActions.isFollowUp=false never calls lifecycle client methods', async () => {
    const startIntent = vi.fn()
    const pauseFollowUp = vi.fn()
    const completeFollowUp = vi.fn()
    const base = createMockFollowUpsClient({
      initialTasks: [MIXED_PLAIN_LARK_RECORD]
    })
    const client = {
      ...base,
      startFollowUpIntent: startIntent,
      pauseFollowUp,
      completeFollowUp
    }

    render(<FollowUpsChrome client={client} />)

    await waitFor(() => {
      expect(screen.getByText('Plain Lark task')).toBeTruthy()
    })

    fireEvent.click(screen.getByText('Plain Lark task'))

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Plain Lark task' })).toBeTruthy()
    })

    expect(screen.queryByRole('button', { name: /Add to context & start/i })).toBeNull()
    expect(startIntent).not.toHaveBeenCalled()
    expect(pauseFollowUp).not.toHaveBeenCalled()
    expect(completeFollowUp).not.toHaveBeenCalled()
  })

  it('renders mixed list and gates lifecycle actions by record kind', async () => {
    const startIntent = vi.fn().mockResolvedValue({ followUp: { ...MIXED_DIVO_RECORD, status: 'starting' } })
    const pauseFollowUp = vi.fn()
    const completeFollowUp = vi.fn()
    const base = createMockFollowUpsClient({
      initialTasks: [MIXED_PLAIN_LARK_RECORD, MIXED_DIVO_RECORD]
    })
    const client = {
      ...base,
      startFollowUpIntent: startIntent,
      pauseFollowUp,
      completeFollowUp
    }

    render(<FollowUpsChrome client={client} />)

    await waitFor(() => {
      expect(screen.getByText('Plain Lark task')).toBeTruthy()
      expect(screen.getByText('Prepare Q2 renewal notes')).toBeTruthy()
    })

    const delegatedTags = screen.getAllByText('Divo Follow Up')
    expect(delegatedTags).toHaveLength(1)

    fireEvent.click(screen.getByText('Plain Lark task'))

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Plain Lark task' })).toBeTruthy()
    })
    expect(screen.queryByRole('button', { name: /Add to context & start/i })).toBeNull()
    expect(screen.getByRole('link', { name: /larksuite\.example\/task\/task_plain/i })).toBeTruthy()
    expect(startIntent).not.toHaveBeenCalled()
    expect(pauseFollowUp).not.toHaveBeenCalled()
    expect(completeFollowUp).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Prepare Q2 renewal notes'))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Add to context & start/i })).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: /Add to context & start/i }))

    expect(startIntent).not.toHaveBeenCalled()
    expect(pauseFollowUp).not.toHaveBeenCalled()
    expect(completeFollowUp).not.toHaveBeenCalled()
  })

  it('queues start intent until a confirmed assistant response passes the threshold', async () => {
    const startIntent = vi.fn().mockResolvedValue({
      followUp: {
        ...MIXED_DIVO_RECORD,
        status: 'active',
        lifecycleActions: ACTIVE_ASSIGNEE_ACTIONS
      }
    })
    const onAddToContext = vi.fn()
    const base = createMockFollowUpsClient({ initialTasks: [MIXED_DIVO_RECORD] })
    const client = {
      ...base,
      startFollowUpIntent: startIntent
    }

    const { rerender } = render(
      <FollowUpsChrome
        client={client}
        confirmedStartDelayMs={30}
        confirmedStartSignal={null}
        onAddToContext={onAddToContext}
      />
    )

    await waitFor(() => {
      expect(screen.getByText('Prepare Q2 renewal notes')).toBeTruthy()
    })

    fireEvent.click(screen.getByText('Prepare Q2 renewal notes'))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Add to context & start/i })).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: /Add to context & start/i }))

    expect(onAddToContext).toHaveBeenCalledWith(expect.objectContaining({ id: 'fu_1' }))
    expect(startIntent).not.toHaveBeenCalled()

    vi.useFakeTimers()
    rerender(
      <FollowUpsChrome
        client={client}
        confirmedStartDelayMs={30}
        confirmedStartSignal={{ activeSessionId: 'session_active', sequence: 'assistant-stream-1' }}
        onAddToContext={onAddToContext}
      />
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(29)
    })
    expect(startIntent).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })

    expect(startIntent).toHaveBeenCalledWith({
      activeSessionId: 'session_active',
      followUpId: 'fu_1'
    })
  })

  it('cancels a pending confirmed start when the context chip is removed', async () => {
    const startIntent = vi.fn().mockResolvedValue({
      followUp: {
        ...MIXED_DIVO_RECORD,
        status: 'active',
        lifecycleActions: ACTIVE_ASSIGNEE_ACTIONS
      }
    })
    const base = createMockFollowUpsClient({ initialTasks: [MIXED_DIVO_RECORD] })
    const client = {
      ...base,
      startFollowUpIntent: startIntent
    }

    function Harness({
      signal
    }: {
      signal: { activeSessionId: string; sequence: string } | null
    }) {
      const [contextIds, setContextIds] = useState<ReadonlySet<string>>(() => new Set())

      return (
        <>
          <button onClick={() => setContextIds(new Set())} type="button">
            Remove pending context
          </button>
          <FollowUpsChrome
            activeContextTaskIds={contextIds}
            client={client}
            confirmedStartDelayMs={30}
            confirmedStartSignal={signal}
            onAddToContext={task => setContextIds(new Set([task.id]))}
          />
        </>
      )
    }

    const { rerender } = render(<Harness signal={null} />)

    await waitFor(() => {
      expect(screen.getByText('Prepare Q2 renewal notes')).toBeTruthy()
    })

    fireEvent.click(screen.getByText('Prepare Q2 renewal notes'))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Add to context & start/i })).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: /Add to context & start/i }))
    fireEvent.click(screen.getByText('Remove pending context'))

    vi.useFakeTimers()
    rerender(<Harness signal={{ activeSessionId: 'session_active', sequence: 'assistant-stream-1' }} />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30)
    })

    expect(startIntent).not.toHaveBeenCalled()
  })
})

describe('FollowUpTaskDetailDrawer lifecycleActions', () => {
  it('shows start action for assigned divo follow-up tasks', () => {
    render(
      <FollowUpTaskDetailDrawer
        onOpenChange={() => undefined}
        open
        task={followUpRecordToTask({
          ...MIXED_DIVO_RECORD,
          lifecycleActions: ASSIGNED_ASSIGNEE_ACTIONS
        })}
      />
    )

    expect(screen.getByRole('button', { name: /Add to context & start/i })).toBeTruthy()
    expect(screen.getByText(/From Vira/i)).toBeTruthy()
  })

  it('shows pause, update doc, complete, and open doc for active assignee affordances', () => {
    render(
      <FollowUpTaskDetailDrawer
        onOpenChange={() => undefined}
        open
        task={followUpRecordToTask({
          id: 'fu_active',
          title: 'Active follow-up',
          status: 'active',
          assignedByName: 'Vira',
          assigneeName: 'Anish',
          dueLabel: 'Today',
          group: 'today',
          delegatedTag: 'Divo Follow Up',
          trackingDocUrl: 'https://larksuite.example/doc/doc_token_1',
          lifecycleActions: ACTIVE_ASSIGNEE_ACTIONS
        })}
      />
    )

    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Mark done' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Update doc' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Open tracking doc/i })).toBeTruthy()
    expect(screen.getByRole('link', { name: /larksuite\.example\/doc\/doc_token_1/i })).toBeTruthy()
  })

  it('shows resume start for paused assignee affordances', () => {
    render(
      <FollowUpTaskDetailDrawer
        onOpenChange={() => undefined}
        open
        task={followUpRecordToTask({
          id: 'fu_paused',
          title: 'Paused follow-up',
          status: 'paused',
          assignedByName: 'Vira',
          assigneeName: 'Anish',
          dueLabel: 'Today',
          group: 'today',
          delegatedTag: 'Divo Follow Up',
          trackingDocUrl: 'https://larksuite.example/doc/doc_token_1',
          lifecycleActions: PAUSED_ASSIGNEE_ACTIONS
        })}
      />
    )

    expect(screen.getByRole('button', { name: /Add to context & start/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Open tracking doc/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Mark done' })).toBeNull()
  })

  it('hides assignee-only actions for manager affordances', () => {
    render(
      <FollowUpTaskDetailDrawer
        onOpenChange={() => undefined}
        open
        task={followUpRecordToTask({
          id: 'fu_active',
          title: 'Active follow-up',
          status: 'active',
          assignedByName: 'Vira',
          assigneeName: 'Anish',
          dueLabel: 'Today',
          group: 'today',
          delegatedTag: 'Divo Follow Up',
          trackingDocUrl: 'https://larksuite.example/doc/doc_token_1',
          lifecycleActions: MANAGER_ACTIVE_ACTIONS
        })}
      />
    )

    expect(screen.queryByRole('button', { name: /Add to context & start/i })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Mark done' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Update doc' })).toBeNull()
    expect(screen.getByRole('button', { name: /Open tracking doc/i })).toBeTruthy()
  })

  it('shows Lark link only for plain Lark lifecycleActions', () => {
    render(
      <FollowUpTaskDetailDrawer
        onOpenChange={() => undefined}
        open
        task={followUpRecordToTask(MIXED_PLAIN_LARK_RECORD)}
      />
    )

    expect(screen.getByRole('heading', { name: 'Plain Lark task' })).toBeTruthy()
    expect(screen.getByRole('link', { name: /larksuite\.example\/task\/task_plain/i })).toBeTruthy()
    expect(screen.queryByText('Divo Follow Up')).toBeNull()
    expect(screen.queryByRole('button', { name: /Add to context & start/i })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Mark done' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Update doc' })).toBeNull()
    expect(screen.getByText(/Plain Lark task — open the Lark task link/i)).toBeTruthy()
  })
})

describe('FollowUpUpdateDocModal', () => {
  it('rejects empty notes', () => {
    render(
      <FollowUpUpdateDocModal
        onOpenChange={() => undefined}
        onSubmit={async () => undefined}
        open
        taskTitle="Active follow-up"
      />
    )

    const updateButton = screen.getByRole('button', { name: 'Update' })
    expect(updateButton.hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByLabelText('Progress note'), { target: { value: '   ' } })
    expect(updateButton.hasAttribute('disabled')).toBe(true)
  })
})

describe('FollowUpCompleteModal', () => {
  it('requires a completion summary before submit', () => {
    render(
      <FollowUpCompleteModal
        onOpenChange={() => undefined}
        onSubmit={async () => undefined}
        open
        taskTitle="Active follow-up"
      />
    )

    const doneButton = screen.getByRole('button', { name: 'Mark done' })
    expect(doneButton.hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByLabelText('Completion summary'), {
      target: { value: 'Finished the rollout notes.' }
    })
    expect(doneButton.hasAttribute('disabled')).toBe(false)
  })
})

describe('FollowUpsChrome update doc wiring', () => {
  it('opens note UI from Update doc and submits through the client', async () => {
    const updateFollowUpDoc = vi.fn().mockResolvedValue({
      followUp: {
        ...ACTIVE_DIVO_RECORD,
        notes: 'Drafted the first pass.'
      }
    })
    const base = createMockFollowUpsClient({ initialTasks: [ACTIVE_DIVO_RECORD] })
    const client = { ...base, updateFollowUpDoc }

    render(<FollowUpsChrome client={client} />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Assign follow-up/i })).toBeTruthy()
    })

    const taskList = document.querySelector('[data-slot="follow-up-task-list"]')
    expect(taskList).toBeTruthy()
    fireEvent.click(within(taskList as HTMLElement).getByText('Active follow-up'))

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Active follow-up' })).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Update doc' }))

    await waitFor(() => {
      expect(screen.getByLabelText('Progress note')).toBeTruthy()
    })

    const updateButton = screen.getByRole('button', { name: 'Update' })
    expect(updateButton.hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByLabelText('Progress note'), {
      target: { value: 'Drafted the first pass.' }
    })
    expect(updateButton.hasAttribute('disabled')).toBe(false)
    fireEvent.click(updateButton)

    await waitFor(() => {
      expect(updateFollowUpDoc).toHaveBeenCalledWith({
        followUpId: 'fu_active',
        note: 'Drafted the first pass.'
      })
    })

    await waitFor(() => {
      expect(screen.queryByLabelText('Progress note')).toBeNull()
    })
  })

  it('shows update doc errors without closing the modal', async () => {
    const updateFollowUpDoc = vi
      .fn()
      .mockRejectedValue(new FollowUpsClientError('Doc append failed', 'update_failed'))
    const base = createMockFollowUpsClient({ initialTasks: [ACTIVE_DIVO_RECORD] })
    const client = { ...base, updateFollowUpDoc }

    render(<FollowUpsChrome client={client} />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Assign follow-up/i })).toBeTruthy()
    })

    const taskList = document.querySelector('[data-slot="follow-up-task-list"]')
    expect(taskList).toBeTruthy()
    fireEvent.click(within(taskList as HTMLElement).getByText('Active follow-up'))

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Active follow-up' })).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Update doc' }))
    fireEvent.change(screen.getByLabelText('Progress note'), {
      target: { value: 'Drafted the first pass.' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))

    await waitFor(() => {
      expect(screen.getByText('Doc append failed')).toBeTruthy()
    })
    expect(screen.getByLabelText('Progress note')).toBeTruthy()
  })
})

describe('FollowUpsChrome complete summary wiring', () => {
  it('opens summary UI before completing and sends the approved summary', async () => {
    const completeFollowUp = vi.fn().mockResolvedValue({
      followUp: {
        ...ACTIVE_DIVO_RECORD,
        status: 'done',
        notes: 'Final manager summary.'
      }
    })
    const base = createMockFollowUpsClient({ initialTasks: [ACTIVE_DIVO_RECORD] })
    const client = { ...base, completeFollowUp }

    render(<FollowUpsChrome client={client} />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Assign follow-up/i })).toBeTruthy()
    })

    const taskList = document.querySelector('[data-slot="follow-up-task-list"]')
    expect(taskList).toBeTruthy()
    fireEvent.click(within(taskList as HTMLElement).getByText('Active follow-up'))

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Active follow-up' })).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Mark done' }))

    await waitFor(() => {
      expect(screen.getByLabelText('Completion summary')).toBeTruthy()
    })
    expect(completeFollowUp).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Completion summary'), {
      target: { value: 'Final manager summary.' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Mark done' }))

    await waitFor(() => {
      expect(completeFollowUp).toHaveBeenCalledWith({
        followUpId: 'fu_active',
        summary: 'Final manager summary.'
      })
    })
  })

  it('generates an editable done summary from chat context', async () => {
    const completeFollowUp = vi.fn().mockResolvedValue({
      followUp: {
        ...ACTIVE_DIVO_RECORD,
        status: 'done',
        notes: 'Generated manager summary.'
      }
    })
    const generateSummary = vi.fn().mockResolvedValue('Generated manager summary.')
    const base = createMockFollowUpsClient({ initialTasks: [ACTIVE_DIVO_RECORD] })
    const client = { ...base, completeFollowUp }

    render(
      <FollowUpsChrome
        client={client}
        onGenerateCompletionSummary={generateSummary}
      />
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Assign follow-up/i })).toBeTruthy()
    })

    const taskList = document.querySelector('[data-slot="follow-up-task-list"]')
    expect(taskList).toBeTruthy()
    fireEvent.click(within(taskList as HTMLElement).getByText('Active follow-up'))
    fireEvent.click(await screen.findByRole('button', { name: 'Mark done' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Generate from chat' }))

    await waitFor(() => {
      expect(generateSummary).toHaveBeenCalledWith(expect.objectContaining({ id: 'fu_active' }))
    })
    expect(screen.getByLabelText('Completion summary')).toHaveProperty('value', 'Generated manager summary.')
  })
})

describe('FollowUpTaskDetailDrawer legacy mock tasks', () => {
  it('still infers actions for mock tasks without explicit lifecycleActions metadata', () => {
    render(
      <FollowUpTaskDetailDrawer
        onOpenChange={() => undefined}
        open
        task={MOCK_FOLLOW_UP_TASKS[1]!}
      />
    )

    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Mark done' })).toBeTruthy()
  })
})

describe('FollowUpActiveBanner', () => {
  it('renders active task count', () => {
    render(<FollowUpActiveBanner tasks={MOCK_FOLLOW_UP_TASKS} />)

    expect(screen.getByText('Active follow-ups')).toBeTruthy()
    expect(screen.getByText('1')).toBeTruthy()
  })

  it('expands to show active task actions', () => {
    render(<FollowUpActiveBanner tasks={MOCK_FOLLOW_UP_TASKS} />)

    fireEvent.click(screen.getByRole('button', { name: /Active follow-ups/i }))
    expect(screen.getAllByRole('button', { name: 'Pause' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: 'Done' }).length).toBeGreaterThan(0)
  })
})
