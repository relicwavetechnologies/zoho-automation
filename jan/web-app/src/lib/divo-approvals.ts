import { invoke } from '@tauri-apps/api/core'

/**
 * The approval inbox. Same RuntimeApproval rows the Lark card carries — a card
 * and this list are two views of one request, and either can resolve it.
 */

export type ApprovalDetail = { label: string; value: string }

export type ApprovalDescription = {
  /** Product name, as the user knows it — "Gmail". */
  tool: string
  /** What is being asked — "Send email". */
  title: string
  details: ApprovalDetail[]
}

export type ApprovalItem = {
  id: string
  toolId: string
  action: string
  status: string
  requestedAt: string
  expiresAt: string | null
  requestedByName: string
  approverName: string
  departmentName: string | null
  deliveredVia: string
  description: ApprovalDescription
  payload: unknown
}

export type ApprovalInbox = {
  awaitingMe: ApprovalItem[]
  requestedByMe: ApprovalItem[]
}

export type ApprovalDecision = 'approved' | 'rejected'

export function getDivoApprovalInbox(): Promise<ApprovalInbox> {
  return invoke<ApprovalInbox>('divo_approval_inbox')
}

export function decideDivoApproval(approvalId: string, decision: ApprovalDecision): Promise<unknown> {
  return invoke('divo_approval_decide', { approvalId, decision })
}

/**
 * "in 2 hours", "in 8 minutes", "expired". A request nobody answers is worth
 * less the longer it waits, so the deadline is part of reading it.
 */
export function expiryLabel(expiresAt: string | null, now = Date.now()): string | null {
  if (!expiresAt) return null
  const remaining = Date.parse(expiresAt) - now
  if (Number.isNaN(remaining)) return null
  if (remaining <= 0) return 'Expired'
  const minutes = Math.round(remaining / 60_000)
  if (minutes < 60) return `Expires in ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `Expires in ${hours} hour${hours === 1 ? '' : 's'}`
  const days = Math.round(hours / 24)
  return `Expires in ${days} day${days === 1 ? '' : 's'}`
}

/** A request that is close to timing out is worth showing differently. */
export function isUrgent(item: ApprovalItem, now = Date.now()): boolean {
  if (!item.expiresAt) return false
  const remaining = Date.parse(item.expiresAt) - now
  return remaining > 0 && remaining <= 60 * 60_000
}
