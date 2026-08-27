/**
 * Digest — when Divo tells the team what is outstanding, and where.
 *
 * A tab rather than a dialog because it is not only a form. Half of it is the
 * record of what already went out, which is the question people actually open
 * this for after a quiet morning: not "what is the schedule" but "did the nine
 * o'clock one go, and what was in it". A dialog can hold a schedule; it cannot
 * hold that.
 *
 * Sits beside Broadcast for the same reason it shares Broadcast's permission:
 * both are Divo acting outward on the department's behalf, rather than a view
 * of the list.
 */
import { useEffect, useState } from 'react'
import { CalendarClock, Check, Send } from 'lucide-react'
import { notify } from '@/lib/notify'
import { Empty, Panel, SkelRows, Switch } from '../ui'
import type { DigestCard, DigestSettings } from '../data/use-follow-ups'

/** `MO`…`SU`, in the order a week is read rather than the order they hash. */
const DAYS = [
  { code: 'MO', label: 'Mon' },
  { code: 'TU', label: 'Tue' },
  { code: 'WE', label: 'Wed' },
  { code: 'TH', label: 'Thu' },
  { code: 'FR', label: 'Fri' },
  { code: 'SA', label: 'Sat' },
  { code: 'SU', label: 'Sun' },
] as const

/*
 * What a department gets before it has chosen anything: twice on weekdays, in
 * the timezone the browser is already in. Defaults the form, never the save —
 * nothing is written until somebody presses the button.
 */
const DEFAULT_TIMES = ['09:00', '18:00']
const DEFAULT_DAYS = ['MO', 'TU', 'WE', 'TH', 'FR']
const MAX_TIMES = 4

const localZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata'
  } catch {
    // A browser that will not name its own zone is not a reason to refuse to
    // render; the field stays editable and the server validates it anyway.
    return 'Asia/Kolkata'
  }
}

const whenLabel = (iso: string | null): string => {
  if (!iso) return '—'
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '—'
  return at.toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

export function DigestTab({ digest, cards, loading, error, refusal, save }: {
  digest: DigestSettings | null
  cards: DigestCard[]
  loading: boolean
  error: string | null
  refusal: string | null
  save: (input: {
    chatId: string
    times: string[]
    days: string[]
    timeZone: string
    paused: boolean
  }) => Promise<void>
}) {
  const [chatId, setChatId] = useState('')
  const [times, setTimes] = useState<string[]>(DEFAULT_TIMES)
  const [days, setDays] = useState<string[]>(DEFAULT_DAYS)
  const [timeZone, setTimeZone] = useState(localZone)
  const [paused, setPaused] = useState(false)
  const [saving, setSaving] = useState(false)

  /*
   * Re-seeded from the server whenever it answers, including after a save.
   * Keyed on the fields rather than on the object so a refresh that returns an
   * identical schedule does not stamp over something half-typed.
   */
  useEffect(() => {
    if (!digest) return
    setChatId(digest.chatId)
    setTimes(digest.times.length ? [...digest.times] : DEFAULT_TIMES)
    setDays(digest.days.length ? [...digest.days] : DEFAULT_DAYS)
    setTimeZone(digest.timeZone)
    setPaused(digest.status !== 'active')
  }, [digest?.id, digest?.chatId, digest?.status, digest?.timeZone, digest?.times.join(','), digest?.days.join(',')])

  const toggleDay = (code: string) => {
    setDays(prev => prev.includes(code) ? prev.filter(d => d !== code) : [...prev, code])
  }

  const setTimeAt = (index: number, value: string) => {
    setTimes(prev => prev.map((t, i) => (i === index ? value : t)))
  }

  // A schedule with no time or no day cannot fire, so the button says so
  // rather than letting the server explain it a round trip later.
  const incomplete = !chatId.trim() || times.length === 0 || days.length === 0

  const onSave = async () => {
    setSaving(true)
    try {
      await save({
        chatId: chatId.trim(),
        // Sorted so the stored schedule reads in clock order however it was
        // typed, and so two identical schedules compare equal in the audit log.
        times: [...times].sort(),
        days: DAYS.filter(d => days.includes(d.code)).map(d => d.code),
        timeZone: timeZone.trim(),
        paused,
      })
      notify.done('Digest saved', paused ? 'Paused — nothing goes out until you switch it on.' : null)
    } catch (e) {
      /*
       * The server's own words, not a generic failure. A room can be refused
       * because Divo has never been in it — which the person reading this can
       * fix in Lark in ten seconds — or because it belongs to another company
       * on the same install, which they cannot fix at all. Collapsing those
       * into "could not save" would send somebody hunting for the wrong thing.
       */
      const detail = e instanceof Error ? e.message : 'The digest could not be saved.'
      notify.failed('The digest was not saved', detail)
    } finally {
      setSaving(false)
    }
  }

  if (refusal) return <Empty icon={CalendarClock} title="Not yours to change" body={refusal} />
  if (loading) return <SkelRows n={4} />

  return (
    <>
      {error ? (
        <div className="ws-ceiling" role="status">{error}</div>
      ) : null}

      <Panel
        title="Where it goes"
        description="The Lark room the summary is posted into. Divo has to already be in it."
      >
        <div className="dg-form">
          <label className="dg-field">
            <span className="dg-lbl">Lark chat ID</span>
            <input
              className="input"
              value={chatId}
              placeholder="oc_…"
              onChange={e => setChatId(e.target.value)}
            />
          </label>
        </div>
      </Panel>

      <Panel
        title="When it goes"
        description={`Up to ${MAX_TIMES} times a day, on the days you choose.`}
      >
        <div className="dg-form">
          <div className="dg-field">
            <span className="dg-lbl">Times</span>
            <div className="dg-times">
              {times.map((time, i) => (
                <span className="dg-time" key={i}>
                  <input
                    type="time"
                    className="input"
                    value={time}
                    onChange={e => setTimeAt(i, e.target.value)}
                  />
                  {times.length > 1 ? (
                    <button
                      type="button"
                      className="dg-drop"
                      onClick={() => setTimes(prev => prev.filter((_, j) => j !== i))}
                      aria-label={`Remove ${time}`}
                    >×</button>
                  ) : null}
                </span>
              ))}
              {times.length < MAX_TIMES ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() => setTimes(prev => [...prev, '12:00'])}
                >Add a time</button>
              ) : null}
            </div>
          </div>

          <div className="dg-field">
            <span className="dg-lbl">Days</span>
            <div className="dg-days">
              {DAYS.map(day => (
                <button
                  type="button"
                  key={day.code}
                  className="dg-day"
                  data-on={days.includes(day.code)}
                  onClick={() => toggleDay(day.code)}
                >{day.label}</button>
              ))}
            </div>
          </div>

          <label className="dg-field">
            <span className="dg-lbl">Timezone</span>
            <input
              className="input"
              value={timeZone}
              placeholder="Asia/Kolkata"
              onChange={e => setTimeZone(e.target.value)}
            />
          </label>

          <div className="dg-field dg-row">
            <Switch
              on={!paused}
              onToggle={() => setPaused(p => !p)}
              label={paused ? 'Paused — nothing is sent' : 'Active'}
            />
            <span className="dg-lbl">
              {paused ? 'Paused — nothing is sent' : 'Active'}
            </span>
          </div>
        </div>

        <div className="dg-foot">
          <div className="dg-when">
            {/* Both, because they answer different questions: one is "is it
                working", the other is "when should I next look". */}
            <span>Last sent <b>{whenLabel(digest?.lastRunAt ?? null)}</b></span>
            <span>Next <b>{paused ? 'paused' : whenLabel(digest?.nextRunAt ?? null)}</b></span>
          </div>
          <button
            type="button"
            className="btn primary"
            disabled={saving || incomplete}
            onClick={() => void onSave()}
          >
            <Check size={13} />
            {saving ? 'Saving…' : digest ? 'Save changes' : 'Start the digest'}
          </button>
        </div>
      </Panel>

      <Panel title="Recently sent" description="One card per handset, per run.">
        {cards.length === 0 ? (
          <Empty
            icon={Send}
            title={digest ? 'Nothing sent yet' : 'No digest configured'}
            body={digest
              ? 'The first one goes out at the next scheduled time.'
              : 'Set a room and a schedule above, and Divo will start posting.'}
          />
        ) : (
          <div className="dg-cards">
            {cards.map(card => (
              <div className="dg-card" key={card.id}>
                <span className="dg-card-num">{card.number}</span>
                <span className="dg-card-n">{card.itemCount} item{card.itemCount === 1 ? '' : 's'}</span>
                <span className="dg-card-at">{whenLabel(card.sentAt)}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </>
  )
}
