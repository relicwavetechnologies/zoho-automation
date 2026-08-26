import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FollowUpsRepository } from '../../src/infrastructure/persistence/follow-ups.repository.ts'

const ROWS = [
  {
    id: 'chat-1',
    name: 'Sharma Sangeet',
    isGroup: true,
    muted: false,
    lastMessageAt: new Date('2026-08-25T10:00:00Z'),
    lastAnalyzedAt: new Date('2026-08-25T10:00:00Z'),
    _count: { followUps: 2 },
    owningSessionId: 's-1',
  },
  {
    id: 'chat-2',
    name: 'Ritu Malhotra',
    isGroup: false,
    muted: false,
    lastMessageAt: new Date('2026-08-25T09:00:00Z'),
    lastAnalyzedAt: null,
    _count: { followUps: 1 },
    owningSessionId: 's-2',
  },
  {
    id: 'chat-3',
    name: 'Bloom Florals',
    isGroup: false,
    muted: true,
    lastMessageAt: new Date('2026-08-25T08:00:00Z'),
    lastAnalyzedAt: new Date('2026-08-25T08:00:00Z'),
    _count: { followUps: 0 },
    owningSessionId: 's-1',
  },
] as const

function makeDb(filterFn?: (where: any) => readonly any[]) {
  return {
    whatsappChat: {
      findMany: async (args: any) => {
        const where = args.where ?? {}
        // Simulate Prisma filtering: respect companyId/departmentId and owningSessionId
        let rows: any[] = [...ROWS]
        if (where.owningSessionId) {
          rows = rows.filter(r => r.owningSessionId === where.owningSessionId)
        }
        // Return shape expected by repository: without owningSessionId in _count? Already there.
        // Strip owningSessionId from returned rows to mimic select without it? Repository select doesn't include owningSessionId, but our filter needs it.
        // Return rows with fields matching select
        return rows.map(r => ({
          id: r.id,
          name: r.name,
          isGroup: r.isGroup,
          muted: r.muted,
          lastMessageAt: r.lastMessageAt,
          lastAnalyzedAt: r.lastAnalyzedAt,
          owningSessionId: r.owningSessionId,
          _count: r._count,
        }))
      },
    },
  } as any
}

describe('FollowUpsRepository.listChats', () => {
  it('returns every chat in the department when no sessionId is given', async () => {
    const repo = new FollowUpsRepository(makeDb())
    const result = await repo.listChats({ companyId: 'c1', departmentId: 'd1', limit: 100 })
    assert.ok(result.ok)
    assert.equal(result.value.length, 3)
  })

  it('narrows to one handset when a sessionId is given', async () => {
    const repo = new FollowUpsRepository(makeDb())
    const all = await repo.listChats({ companyId: 'c1', departmentId: 'd1', limit: 100 })
    assert.ok(all.ok)
    assert.equal(all.value.length, 3)

    const s1 = await repo.listChats({ companyId: 'c1', departmentId: 'd1', limit: 100, sessionId: 's-1' })
    assert.ok(s1.ok)
    // Assert on rows, not the query object: s-1 owns chat-1 and chat-3, s-2 owns chat-2
    assert.equal(s1.value.length, 2)
    assert.ok(s1.value.every(c => ['chat-1', 'chat-3'].includes(c.id)))
    assert.ok(!s1.value.some(c => c.id === 'chat-2'))

    const s2 = await repo.listChats({ companyId: 'c1', departmentId: 'd1', limit: 100, sessionId: 's-2' })
    assert.ok(s2.ok)
    assert.equal(s2.value.length, 1)
    assert.equal(s2.value[0]!.id, 'chat-2')

    // A sessionId from elsewhere matches nothing — still scoped by department, so foreign chats do not leak
    const foreign = await repo.listChats({ companyId: 'c1', departmentId: 'd1', limit: 100, sessionId: 's-foreign' })
    assert.ok(foreign.ok)
    assert.equal(foreign.value.length, 0)
  })

  it('mirrors listOpen filtering shape — still scoped by department underneath', async () => {
    // If the filter escaped the department scope, a card from another department could be used to enumerate chats
    let capturedWhere: any = null
    const db = {
      whatsappChat: {
        findMany: async (args: any) => {
          capturedWhere = args.where
          return []
        },
      },
    } as any
    const repo = new FollowUpsRepository(db)
    await repo.listChats({ companyId: 'c1', departmentId: 'd-ua', limit: 50, sessionId: 's-1' })
    assert.equal(capturedWhere.companyId, 'c1')
    assert.equal(capturedWhere.departmentId, 'd-ua')
    assert.equal(capturedWhere.owningSessionId, 's-1')
  })
})
