import type { FollowUpRecord } from '@/lib/follow-ups/api-types'

import type { TodayDocItem, TodayMeeting, TodayNeedsYouItem } from './api-types'

export type LarkContextKind = 'task' | 'meeting' | 'approval' | 'mention' | 'wiki' | 'doc'

export interface LarkContextRef {
  id: string
  kind: LarkContextKind
  label: string
  detail?: string
  larkRef: string
  payload?: Record<string, string>
}

const KIND_LABEL: Record<LarkContextKind, string> = {
  task: 'TASK',
  meeting: 'MEETING',
  approval: 'APPROVAL',
  mention: 'MENTION',
  wiki: 'WIKI',
  doc: 'DOC'
}

export function larkContextKindLabel(kind: LarkContextKind): string {
  return KIND_LABEL[kind]
}

export function contextRefFromTask(record: FollowUpRecord): LarkContextRef {
  const guid = record.larkTaskGuid ?? record.id.replace(/^lark:/, '')
  return {
    id: record.id,
    kind: 'task',
    label: record.title,
    detail: record.dueLabel,
    larkRef: `@lark-task:${guid}`,
    payload: {
      taskGuid: guid,
      ...(record.larkTaskUrl ? { larkTaskUrl: record.larkTaskUrl } : {})
    }
  }
}

export function contextRefFromMeeting(meeting: TodayMeeting): LarkContextRef {
  return {
    id: meeting.id,
    kind: 'meeting',
    label: meeting.title,
    detail: `${meeting.time} · ${meeting.sub}`,
    larkRef: `@lark-event:${meeting.eventId}`,
    payload: {
      eventId: meeting.eventId,
      startTime: meeting.startTime ?? meeting.time,
      summary: meeting.title,
      ...(meeting.vcUrl ? { vcUrl: meeting.vcUrl } : {})
    }
  }
}

export function contextRefFromNeedsYou(item: TodayNeedsYouItem): LarkContextRef {
  if (item.kind === 'approval') {
    const code = item.instanceCode ?? item.id.replace(/^approval:/, '')
    return {
      id: item.id,
      kind: 'approval',
      label: item.title,
      detail: item.meta,
      larkRef: `@lark-approval:${code}`,
      payload: {
        instanceCode: code,
        ...(item.approvalCode ? { approvalCode: item.approvalCode } : {})
      }
    }
  }

  const messageId = item.messageId ?? item.id.replace(/^mention:/, '')
  return {
    id: item.id,
    kind: 'mention',
    label: item.title,
    detail: item.meta,
    larkRef: `@lark-message:${messageId}`,
    payload: {
      messageId,
      ...(item.chatId ? { chatId: item.chatId } : {})
    }
  }
}

export function contextRefFromDoc(item: TodayDocItem): LarkContextRef {
  const token = item.docToken ?? item.docUrl ?? item.id.replace(/^(doc|wiki):/, '')
  return {
    id: item.id,
    kind: item.kind === 'wiki' ? 'wiki' : 'doc',
    label: item.title,
    detail: item.meta,
    larkRef: `@lark-doc:${token}`,
    payload: {
      docToken: token,
      ...(item.docUrl ? { docUrl: item.docUrl } : {})
    }
  }
}

export function buildLarkContextBlock(refs: ReadonlyArray<LarkContextRef>): string {
  if (!refs.length) {
    return ''
  }

  const lines = refs.map(ref => {
    const payload = ref.payload
      ? ` (${Object.entries(ref.payload)
          .map(([key, value]) => `${key}=${value}`)
          .join(', ')})`
      : ''
    return `- ${ref.kind}: ${ref.label}${payload}`
  })

  return ['[LARK CONTEXT]', ...lines, '[/LARK CONTEXT]', ''].join('\n')
}

const LARK_CONTEXT_BLOCK_RE = /^\[LARK CONTEXT\]\n([\s\S]*?)\n\[\/LARK CONTEXT\]\n?/

export interface LarkContextDisplayRef {
  kind: LarkContextKind
  label: string
  detail?: string
}

function parseLarkContextLine(line: string): LarkContextDisplayRef | null {
  const trimmed = line.trim()

  if (!trimmed.startsWith('- ')) {
    return null
  }

  const body = trimmed.slice(2)
  const separator = body.indexOf(': ')

  if (separator <= 0) {
    return null
  }

  const kind = body.slice(0, separator) as LarkContextKind

  if (!(kind in KIND_LABEL)) {
    return null
  }

  let label = body.slice(separator + 2)
  const payloadStart = label.lastIndexOf(' (')

  if (payloadStart > 0 && label.endsWith(')')) {
    label = label.slice(0, payloadStart)
  }

  return { kind, label }
}

/** Split a submitted prompt into visible chips + user text (hides the raw block). */
export function parseLarkContextBlock(text: string): { refs: LarkContextDisplayRef[]; body: string } {
  const match = text.match(LARK_CONTEXT_BLOCK_RE)

  if (!match) {
    return { refs: [], body: text }
  }

  const refs = match[1]
    .split('\n')
    .map(parseLarkContextLine)
    .filter((ref): ref is LarkContextDisplayRef => ref !== null)

  return {
    refs,
    body: text.slice(match[0].length)
  }
}
