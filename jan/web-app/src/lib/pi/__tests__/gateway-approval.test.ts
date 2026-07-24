import { describe, expect, it } from 'vitest'
import {
  isDivoGatewayApprovalTool,
  readDivoGatewayApproval,
} from '../gateway-approval'

describe('Divo gateway approval status', () => {
  it('reads a pending backend approval from Pi error output', () => {
    const details = readDivoGatewayApproval({
      type: 'tool-divo_gateway',
      errorText: JSON.stringify({
        content: [{ type: 'text', text: 'Approval required.' }],
        details: {
          status: 'approval_required',
          approval: {
            approvalId: 'approval-42',
            message: 'Sent to Finance.',
            authority: 'department_manager',
            approverName: 'Finance Manager',
            requestState: 'reused',
            nextAction: 'wait',
          },
        },
        isError: true,
      }),
    })

    expect(details).toEqual({
      state: 'pending',
      approvalId: 'approval-42',
      message: 'Sent to Finance.',
      authority: 'department_manager',
      approverName: 'Finance Manager',
      requestState: 'reused',
      nextAction: 'wait',
    })
  })

  it('reads a rejected backend approval from normal tool output', () => {
    const details = readDivoGatewayApproval({
      toolName: 'divo_gateway',
      output: {
        details: {
          status: 'approval_rejected',
          approval: { approvalId: 'approval-43' },
        },
      },
    })

    expect(details).toEqual({
      state: 'rejected',
      approvalId: 'approval-43',
      message: 'This action was not approved.',
    })
  })

  it('reads an uncertain failed approved execution as a structured terminal state', () => {
    const details = readDivoGatewayApproval({
      type: 'tool-divo_gateway',
      errorText: JSON.stringify({
        details: {
          status: 'approval_execution_failed',
          approval: {
            approvalId: 'approval-failed',
            message: 'Provider outcome may be uncertain.',
            requestState: 'reused',
            nextAction: 'change_request',
          },
        },
      }),
    })

    expect(details).toEqual({
      state: 'failed',
      approvalId: 'approval-failed',
      message: 'Provider outcome may be uncertain.',
      requestState: 'reused',
      nextAction: 'change_request',
    })
  })

  it('rejects prose, malformed payloads, and non-gateway tools', () => {
    expect(
      isDivoGatewayApprovalTool({
        type: 'tool-divo_gateway',
        errorText: 'Approval required. Approval ID: approval-42',
      })
    ).toBe(false)
    expect(
      readDivoGatewayApproval({
        type: 'tool-bash',
        errorText: JSON.stringify({ details: { status: 'approval_required' } }),
      })
    ).toBeUndefined()
  })
})
